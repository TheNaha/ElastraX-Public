import { createHash, randomUUID } from 'node:crypto';
import { sqlite } from '../db';
import type { MessageContext } from '../core/MessageContext';

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 5;

export type InboxAdmission = {
  id: number;
  accepted: boolean;
  reason?: 'duplicate' | 'completed' | 'dead_letter';
  eventKey: string;
};

function eventKeyFor(ctx: MessageContext): string {
  const messageId = ctx.messageId?.trim();
  if (!messageId || messageId.toLowerCase() === 'unknown') return `local:${randomUUID()}`;
  return createHash('sha256')
    .update(`${ctx.platform}\u0000${ctx.chatId}\u0000${messageId}`)
    .digest('hex');
}

export class InboxService {
  static admit(ctx: MessageContext): InboxAdmission {
    const now = Date.now();
    const eventKey = eventKeyFor(ctx);
    const result = sqlite
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
    if (Number(result.changes) === 1) return { id: Number(row.id), accepted: true, eventKey };
    if (row.state === 'completed') return { id: Number(row.id), accepted: false, reason: 'completed', eventKey };
    if (row.state === 'dead_letter') return { id: Number(row.id), accepted: false, reason: 'dead_letter', eventKey };
    return { id: Number(row.id), accepted: true, reason: 'duplicate', eventKey };
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
