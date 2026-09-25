import { createHash, randomUUID } from 'node:crypto';
import type { SQLQueryBindings } from 'bun:sqlite';
import { sqlite } from '../db';
import type { MessageContext } from '../core/MessageContext';
import { hasRoomKeyColumn, remoteRoomIdFromKey, roomKeyForContext } from './roomKeys';

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 5;

export type InboxAdmission = {
  id: number;
  accepted: boolean;
  reason?: 'duplicate' | 'completed' | 'dead_letter';
  eventKey: string;
  /** Canonical room key the event was filed under. */
  roomKey: string;
  /** Raw provider room id, retained so a row can be rolled back. */
  chatRoomId: string;
};

export type InboxRoomRow = {
  id: number;
  platform: string;
  roomKey: string;
  chatRoomId: string;
  state: string;
  providerMessageId: string | null;
  receivedAt: number;
};

function eventKeyFor(ctx: MessageContext): string {
  const messageId = ctx.messageId?.trim();
  if (!messageId || messageId.toLowerCase() === 'unknown') return `local:${randomUUID()}`;
  return createHash('sha256')
    .update(`${ctx.platform}\u0000${ctx.chatId}\u0000${messageId}`)
    .digest('hex');
}

export class InboxService {
  /**
   * Admit one provider event.  The canonical room key is stored alongside the
   * raw provider room id: room-scoped queries use `room_key`, rollback and
   * provider delivery use `chat_room_id`.
   */
  static admit(ctx: MessageContext): InboxAdmission {
    const now = Date.now();
    const eventKey = eventKeyFor(ctx);
    const roomKey = roomKeyForContext(ctx);
    const withRoomKey = hasRoomKeyColumn('message_inbox');
    const result = withRoomKey
      ? sqlite
        .query<never, [string, string, string, string | null, string, number, number, number, number]>(
          `INSERT INTO message_inbox
             (platform, chat_room_id, room_key, provider_message_id, event_key, payload,
              received_at, available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
           ON CONFLICT(platform, event_key) DO NOTHING`,
        )
        .run(
          ctx.platform,
          ctx.chatId,
          roomKey,
          ctx.messageId?.trim() || null,
          eventKey,
          now,
          now,
          now,
          now,
        )
      : sqlite
        .query<never, [string, string, string | null, string, number, number, number, number]>(
          `INSERT INTO message_inbox
             (platform, chat_room_id, provider_message_id, event_key, payload,
              received_at, available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?)
           ON CONFLICT(platform, event_key) DO NOTHING`,
        )
        .run(
          ctx.platform,
          ctx.chatId,
          ctx.messageId?.trim() || null,
          eventKey,
          now,
          now,
          now,
          now,
        );
    const row = sqlite
      .query<{ id: number; state: string }, [string, string]>(
        'SELECT id, state FROM message_inbox WHERE platform = ? AND event_key = ?',
      )
      .get(ctx.platform, eventKey);
    if (!row) throw new Error('Unable to admit provider event');
    const id = Number(row.id);
    if (Number(result.changes) === 1) return { id, accepted: true, eventKey, roomKey, chatRoomId: ctx.chatId };
    if (row.state === 'completed') {
      return { id, accepted: false, reason: 'completed', eventKey, roomKey, chatRoomId: ctx.chatId };
    }
    if (row.state === 'dead_letter') {
      return { id, accepted: false, reason: 'dead_letter', eventKey, roomKey, chatRoomId: ctx.chatId };
    }
    return { id, accepted: true, reason: 'duplicate', eventKey, roomKey, chatRoomId: ctx.chatId };
  }

  /**
   * Room-scoped diagnostic read.  Prefers the canonical key and falls back to the
   * raw provider room id so pre-migration rows stay visible after the room has
   * been re-keyed.
   */
  static findByRoom(roomKey: string, platform?: string, limit = 50): InboxRoomRow[] {
    if (!roomKey) return [];
    const ids = [roomKey];
    const remote = remoteRoomIdFromKey(roomKey);
    if (remote) ids.push(remote);
    const placeholders = ids.map(() => '?').join(',');
    const keyColumn = hasRoomKeyColumn('message_inbox') ? 'room_key' : 'chat_room_id';
    const params: SQLQueryBindings[] = [...ids, platform ?? null, platform ?? null, Math.max(1, Math.min(500, limit))];
    const rows = sqlite
      .query<InboxRoomRow, SQLQueryBindings[]>(
        `SELECT id, platform, ${keyColumn} AS roomKey, chat_room_id AS chatRoomId,
                state, provider_message_id AS providerMessageId, received_at AS receivedAt
         FROM message_inbox
         WHERE ${keyColumn} IN (${placeholders}) AND (? IS NULL OR platform = ?)
         ORDER BY received_at DESC
         LIMIT ?`,
      )
      .all(...params);
    return rows.map(row => ({ ...row, roomKey: row.roomKey ?? roomKey }));
  }

  static claim(id: number, owner: string): boolean {
    const now = Date.now();
    const result = sqlite
      .query<never, [string, number, number, number, number, number]>(
        `UPDATE message_inbox
         SET state = 'processing', lease_owner = ?, lease_expires_at = ?,
             attempt_count = attempt_count + 1, updated_at = ?
         WHERE id = ? AND available_at <= ?
           AND (state IN ('received', 'failed') OR (state = 'processing' AND lease_expires_at <= ?))`,
      )
      .run(owner, now + LEASE_MS, now, id, now, now);
    return Number(result.changes) === 1;
  }

  static complete(id: number, owner: string): boolean {
    const now = Date.now();
    const result = sqlite
      .query<never, [number, number, number, string]>(
        `UPDATE message_inbox
         SET state = 'completed', completed_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND state = 'processing' AND lease_owner = ?`,
      )
      .run(now, now, id, owner);
    return Number(result.changes) === 1;
  }

  static deferUnclaimed(id: number, error: unknown, delayMs = 5_000): void {
    const now = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    sqlite
      .query<never, [number, string, number, number, number]>(
        `UPDATE message_inbox
         SET state = CASE WHEN attempt_count + 1 >= ? THEN 'dead_letter' ELSE 'failed' END,
             attempt_count = attempt_count + 1, last_error = ?, available_at = ?, updated_at = ?
         WHERE id = ? AND state = 'received'`,
      )
      .run(MAX_ATTEMPTS, message.slice(0, 2_000), now + delayMs, now, id);
  }

  static fail(id: number, owner: string, error: unknown): 'retry' | 'dead_letter' | 'not_owned' {
    const now = Date.now();
    const row = sqlite
      .query<{ attemptCount: number }, [number, string]>(
        `SELECT attempt_count AS attemptCount FROM message_inbox
         WHERE id = ? AND state = 'processing' AND lease_owner = ?`,
      )
      .get(id, owner);
    if (!row) return 'not_owned';
    const state: 'retry' | 'dead_letter' = row.attemptCount >= MAX_ATTEMPTS ? 'dead_letter' : 'retry';
    const retryDelay = Math.min(60 * 60_000, 5_000 * 2 ** Math.max(0, row.attemptCount - 1));
    const message = error instanceof Error ? error.message : String(error);
    sqlite
      .query<never, [string, string, number, number, number, string]>(
        `UPDATE message_inbox
         SET state = ?, last_error = ?, available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'processing' AND lease_owner = ?`,
      )
      .run(state, message.slice(0, 2_000), now + retryDelay, now, id, owner);
    return state;
  }
}
