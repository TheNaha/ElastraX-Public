import { createHash, randomUUID } from 'node:crypto';
import { sqlite, withImmediateTransaction } from '../db';

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 5;
const MAX_TEXT_BYTES = 100_000;

export type ClaimedOutboxMessage = {
  id: string;
  platform: string;
  chatRoomId: string;
  text: string;
  attemptCount: number;
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

export class OutboxService {
  static enqueueText(
    platform: string,
    chatRoomId: string,
    text: string,
    keyParts: string[],
    availableAt = Date.now(),
  ): string {
    if (process.env.NODE_ENV === 'test' && typeof (sqlite as unknown as { query?: unknown }).query !== 'function') {
      return `test:${randomUUID()}`;
    }
    const now = Date.now();
    const id = randomUUID();
    const payload = JSON.stringify({ text: normalizeText(text) });
    const key = idempotencyKey([platform, ...keyParts]);
    const row = sqlite
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

  static recordTextDelivered(platform: string, chatRoomId: string, text: string, keyParts: string[]): string {
    if (process.env.NODE_ENV === 'test' && typeof (sqlite as unknown as { query?: unknown }).query !== 'function') {
      return `test:${randomUUID()}`;
    }
    const now = Date.now();
    const key = idempotencyKey([platform, ...keyParts]);
    const id = randomUUID();
    const row = sqlite
      .query<{ id: string }, [string, string, string, string, string, number, number, number, number]>(
        `INSERT INTO message_outbox
           (id, platform, chat_room_id, idempotency_key, payload, state,
            sent_at, available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?)
         ON CONFLICT(platform, idempotency_key) DO NOTHING
         RETURNING id`,
      )
      .get(
        id,
        platform,
        chatRoomId,
        key,
        JSON.stringify({ text: normalizeText(text) }),
        now,
        now,
        now,
        now,
      );
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
          .query<{ id: string; platform: string; chatRoomId: string; payload: string; attemptCount: number }, [string]>(
            `SELECT id, platform, chat_room_id AS chatRoomId, payload,
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
        claimed.push({ ...row, text });
      }
      return claimed;
    });
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
    const state: 'retry' | 'dead_letter' = row.attemptCount >= MAX_ATTEMPTS ? 'dead_letter' : 'retry';
    const delay = Math.min(60 * 60_000, 5_000 * 2 ** Math.max(0, row.attemptCount - 1));
    const message = error instanceof Error ? error.message : String(error);
    sqlite
      .query<never, [string, string, number, number, string, string]>(
        `UPDATE message_outbox
         SET state = ?, last_error = ?, available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'leased' AND lease_owner = ?`,
      )
      .run(state, message.slice(0, 2_000), now + delay, now, id, owner);
    return state;
  }
}
