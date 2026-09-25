import { createHash, randomUUID } from 'node:crypto';
import type { SQLQueryBindings } from 'bun:sqlite';
import { sqlite, withImmediateTransaction } from '../db';
import { hasRoomKeyColumn, remoteRoomIdFromKey, resolveCanonicalRoomKey } from './roomKeys';

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 5;
const MAX_TEXT_BYTES = 100_000;

export type OutboxEnqueueOptions = {
  availableAt?: number;
  /** Canonical room key; derived from platform + chatRoomId when omitted. */
  roomKey?: string;
};

export type ClaimedOutboxMessage = {
  id: string;
  platform: string;
  /** Canonical room key (empty on pre-migration rows). */
  roomKey: string;
  /** Raw provider room id — this is what providers must receive. */
  chatRoomId: string;
  text: string;
  attemptCount: number;
};

export type PendingOutboxRow = {
  id: string;
  platform: string;
  roomKey: string;
  chatRoomId: string;
  state: string;
  availableAt: number;
};

function normalizeText(text: string): string {
  const value = text.trim();
  const bytes = Buffer.from(value, 'utf8');
  return bytes.byteLength <= MAX_TEXT_BYTES
    ? value
    : `${bytes.subarray(0, MAX_TEXT_BYTES).toString('utf8')}\n[Message truncated]`;
}

function idempotencyKey(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function enqueueOptions(options?: number | OutboxEnqueueOptions): OutboxEnqueueOptions {
  return typeof options === 'number' ? { availableAt: options } : (options ?? {});
}

function roomKeyFor(platform: string, chatRoomId: string, explicit?: string): string {
  const provided = explicit?.trim();
  return provided && provided.length > 0 ? provided : resolveCanonicalRoomKey(platform, chatRoomId);
}

export class OutboxService {
  static enqueueText(
    platform: string,
    chatRoomId: string,
    text: string,
    keyParts: string[],
    options?: number | OutboxEnqueueOptions,
  ): string {
    if (process.env.NODE_ENV === 'test' && typeof (sqlite as unknown as { query?: unknown }).query !== 'function') {
      return `test:${randomUUID()}`;
    }
    const { availableAt = Date.now(), roomKey: explicitRoomKey } = enqueueOptions(options);
    const now = Date.now();
    const id = randomUUID();
    const roomKey = roomKeyFor(platform, chatRoomId, explicitRoomKey);
    const payload = JSON.stringify({ text: normalizeText(text) });
    const key = idempotencyKey([platform, ...keyParts]);
    const row = hasRoomKeyColumn('message_outbox')
      ? sqlite
        .query<{ id: string }, [string, string, string, string, string, string, number, number, number]>(
          `INSERT INTO message_outbox
             (id, platform, chat_room_id, room_key, idempotency_key, payload, state,
              available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
           ON CONFLICT(platform, idempotency_key) DO NOTHING
           RETURNING id`,
        )
        .get(id, platform, chatRoomId, roomKey, key, payload, availableAt, now, now)
      : sqlite
        .query<{ id: string }, [string, string, string, string, string, number, number, number]>(
          `INSERT INTO message_outbox
             (id, platform, chat_room_id, idempotency_key, payload, state,
              available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
           ON CONFLICT(platform, idempotency_key) DO NOTHING
           RETURNING id`,
        )
        .get(id, platform, chatRoomId, key, payload, availableAt, now, now);
    if (row) return String(row.id);
    const existing = sqlite
      .query<{ id: string }, [string, string]>(
        'SELECT id FROM message_outbox WHERE platform = ? AND idempotency_key = ?',
      )
      .get(platform, key);
    if (!existing) throw new Error('Unable to enqueue outbox message');
    return String(existing.id);
  }

  static recordTextDelivered(
    platform: string,
    chatRoomId: string,
    text: string,
    keyParts: string[],
    options?: number | OutboxEnqueueOptions,
  ): string {
    if (process.env.NODE_ENV === 'test' && typeof (sqlite as unknown as { query?: unknown }).query !== 'function') {
      return `test:${randomUUID()}`;
    }
    const { availableAt = Date.now(), roomKey: explicitRoomKey } = enqueueOptions(options);
    const now = Date.now();
    const key = idempotencyKey([platform, ...keyParts]);
    const id = randomUUID();
    const roomKey = roomKeyFor(platform, chatRoomId, explicitRoomKey);
    const payload = JSON.stringify({ text: normalizeText(text) });
    const row = hasRoomKeyColumn('message_outbox')
      ? sqlite
        .query<{ id: string }, [string, string, string, string, string, string, number, number, number, number]>(
          `INSERT INTO message_outbox
             (id, platform, chat_room_id, room_key, idempotency_key, payload, state,
              sent_at, available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?)
           ON CONFLICT(platform, idempotency_key) DO NOTHING
           RETURNING id`,
        )
        .get(id, platform, chatRoomId, roomKey, key, payload, now, availableAt, now, now)
      : sqlite
        .query<{ id: string }, [string, string, string, string, string, number, number, number, number]>(
          `INSERT INTO message_outbox
             (id, platform, chat_room_id, idempotency_key, payload, state,
              sent_at, available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?)
           ON CONFLICT(platform, idempotency_key) DO NOTHING
           RETURNING id`,
        )
        .get(id, platform, chatRoomId, key, payload, now, availableAt, now, now);
    if (row) return String(row.id);
    const existing = sqlite
      .query<{ id: string }, [string, string]>(
        'SELECT id FROM message_outbox WHERE platform = ? AND idempotency_key = ?',
      )
      .get(platform, key);
    if (!existing) throw new Error('Unable to record delivered message');
    return String(existing.id);
  }

  static claim(owner: string, platforms: readonly string[], limit = 10): ClaimedOutboxMessage[] {
    if (platforms.length === 0) return [];
    const now = Date.now();
    const roomKeyColumn = hasRoomKeyColumn('message_outbox') ? 'room_key' : "''";
    return withImmediateTransaction(sqlite, () => {
      const placeholders = platforms.map(() => '?').join(',');
      const candidates = sqlite
        .query<{ id: string }, [...string[], number, number, number]>(
          `SELECT id FROM message_outbox
           WHERE platform IN (${placeholders})
             AND available_at <= ?
             AND (state IN ('pending', 'failed') OR (state = 'leased' AND lease_expires_at <= ?))
           ORDER BY available_at, created_at
           LIMIT ?`,
        )
        .all(...platforms, now, now, Math.max(1, Math.min(50, limit)));
      const claimed: ClaimedOutboxMessage[] = [];
      for (const candidate of candidates) {
        const result = sqlite
          .query<never, [string, number, number, string, number, number]>(
            `UPDATE message_outbox
             SET state = 'leased', lease_owner = ?, lease_expires_at = ?,
                 attempt_count = attempt_count + 1, updated_at = ?
             WHERE id = ? AND available_at <= ?
               AND (state IN ('pending', 'failed') OR (state = 'leased' AND lease_expires_at <= ?))`,
          )
          .run(owner, now + LEASE_MS, now, candidate.id, now, now);
        if (Number(result.changes) !== 1) continue;
        const row = sqlite
          .query<{ id: string; platform: string; roomKey: string; chatRoomId: string; payload: string; attemptCount: number }, [string]>(
            `SELECT id, platform, ${roomKeyColumn} AS roomKey, chat_room_id AS chatRoomId, payload,
                    attempt_count AS attemptCount
             FROM message_outbox WHERE id = ?`,
          )
          .get(candidate.id);
        if (!row) continue;
        let text = '';
        try {
          const payload = JSON.parse(row.payload) as { text?: unknown };
          text = typeof payload.text === 'string' ? payload.text : '';
        } catch {
          text = '';
        }
        claimed.push({ ...row, roomKey: row.roomKey ?? '', text });
      }
      return claimed;
    });
  }

  /**
   * Room-scoped diagnostic read, keyed on the canonical room key with a fallback
   * to the raw provider room id for rows written before the room was re-keyed.
   */
  static pendingForRoom(roomKey: string, platform?: string, limit = 50): PendingOutboxRow[] {
    const ids = [roomKey];
    const remote = remoteRoomIdFromKey(roomKey);
    if (remote) ids.push(remote);
    const placeholders = ids.map(() => '?').join(',');
    const roomKeyColumn = hasRoomKeyColumn('message_outbox') ? 'room_key' : 'chat_room_id';
    const params: SQLQueryBindings[] = [...ids, platform ?? null, platform ?? null, Math.max(1, Math.min(500, limit))];
    const rows = sqlite
      .query<PendingOutboxRow, SQLQueryBindings[]>(
        `SELECT id, platform, ${roomKeyColumn} AS roomKey, chat_room_id AS chatRoomId,
                state, available_at AS availableAt
         FROM message_outbox
         WHERE ${roomKeyColumn} IN (${placeholders}) AND (? IS NULL OR platform = ?)
         ORDER BY available_at
         LIMIT ?`,
      )
      .all(...params);
    return rows.map(row => ({ ...row, roomKey: row.roomKey ?? roomKey }));
  }

  static markEnqueuedSent(id: string, providerMessageId: string | null = null): boolean {
    const now = Date.now();
    const result = sqlite
      .query<never, [string | null, number, number, string]>(
        `UPDATE message_outbox
         SET state = 'sent', provider_message_id = ?, sent_at = ?, updated_at = ?
         WHERE id = ? AND state IN ('pending', 'failed')`,
      )
      .run(providerMessageId, now, now, id);
    return Number(result.changes) === 1;
  }

  static markSent(id: string, owner: string, providerMessageId: string | null = null): boolean {
    const now = Date.now();
    const result = sqlite
      .query<never, [string | null, number, number, string, string]>(
        `UPDATE message_outbox
         SET state = 'sent', provider_message_id = ?, sent_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND state = 'leased' AND lease_owner = ?`,
      )
      .run(providerMessageId, now, now, id, owner);
    return Number(result.changes) === 1;
  }

  static fail(id: string, owner: string, error: unknown): 'retry' | 'dead_letter' | 'not_owned' {
    const now = Date.now();
    const row = sqlite
      .query<{ attemptCount: number }, [string, string]>(
        `SELECT attempt_count AS attemptCount FROM message_outbox
         WHERE id = ? AND state = 'leased' AND lease_owner = ?`,
      )
      .get(id, owner);
    if (!row) return 'not_owned';
    const outcome: 'retry' | 'dead_letter' = row.attemptCount >= MAX_ATTEMPTS ? 'dead_letter' : 'retry';
    // The table only accepts 'failed'/'dead_letter'; 'retry' is the caller-facing name.
    const persistedState = outcome === 'retry' ? 'failed' : 'dead_letter';
    const delay = Math.min(60 * 60_000, 5_000 * 2 ** Math.max(0, row.attemptCount - 1));
    const message = error instanceof Error ? error.message : String(error);
    sqlite
      .query<never, [string, string, number, number, string, string]>(
        `UPDATE message_outbox
         SET state = ?, last_error = ?, available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'leased' AND lease_owner = ?`,
      )
      .run(persistedState, message.slice(0, 2_000), now + delay, now, id, owner);
    return outcome;
  }
}
