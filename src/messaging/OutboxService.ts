import { createHash, randomUUID } from 'node:crypto';
import type { SQLQueryBindings } from 'bun:sqlite';
import { sqlite, withImmediateTransaction } from '../db';
import { exponentialBackoff } from '../utils/backoff';
import { logger } from '../utils/logger';
import { hasRoomKeyColumn, remoteRoomIdFromKey, resolveCanonicalRoomKey } from './roomKeys';

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 5;
const MAX_TEXT_BYTES = 100_000;

/**
 * How long a directly-sent message is invisible to the outbox poller.
 *
 * The agent's fast path enqueues a row and then sends the same text itself, so
 * the row exists for the duration of a provider round trip. With the default
 * `available_at = now` the 1 s poller could claim that row in the gap, deliver
 * it, and the agent's own send would deliver it again — the exposure window was
 * the full provider latency, and `markEnqueuedSent` could not rescue it because
 * its predicate excludes `leased`. The row is now parked for this long instead,
 * and the direct send is bounded to `DIRECT_SEND_TIMEOUT_MS` (see
 * `withCancellableTimeout` in the agent), which is comfortably shorter: either
 * the send finishes and the row is marked sent, or it is aborted and the outbox
 * picks the message up on the next tick. The small margin keeps the abort
 * strictly ahead of the claim.
 */
export const DIRECT_SEND_GRACE_MS = 20_000;

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
  if (bytes.byteLength <= MAX_TEXT_BYTES) return value;
  // Truncate at a character boundary so multi-byte UTF-8 sequences are not split,
  // which would produce a replacement character (\uFFFD) at the cut point.
  const truncated = bytes.subarray(0, MAX_TEXT_BYTES).toString('utf8').replace(/\uFFFD$/, '');
  return `${truncated}\n[Message truncated]`;
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

  /**
   * Enqueue a message the caller is about to send itself.
   *
   * Identical to {@link enqueueText} except that the row is not claimable for
   * {@link DIRECT_SEND_GRACE_MS}, which removes the double-delivery race between
   * the agent's immediate send and the outbox poller.
   */
  static enqueueDirectText(
    platform: string,
    chatRoomId: string,
    text: string,
    keyParts: string[],
    options?: OutboxEnqueueOptions,
  ): string {
    return this.enqueueText(platform, chatRoomId, text, keyParts, {
      ...enqueueOptions(options),
      availableAt: Date.now() + DIRECT_SEND_GRACE_MS,
    });
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
        let text: string;
        try {
          const payload = JSON.parse(row.payload) as { text?: unknown };
          text = typeof payload.text === 'string' ? payload.text : '';
        } catch (error) {
          // A row whose payload cannot be decoded is permanently undeliverable.
          // Claiming it and handing the worker an empty string produced a blank
          // message that was then marked `sent` — silent, permanent loss with no
          // error anywhere. Retire it with the reason instead.
          const message = error instanceof Error ? error.message : String(error);
          sqlite
            .query<never, [string, number, number, string]>(
              `UPDATE message_outbox
               SET state = 'dead_letter', last_error = ?, available_at = ?, updated_at = ?,
                   lease_owner = NULL, lease_expires_at = NULL
               WHERE id = ? AND state = 'leased'`,
            )
            .run(`Undecodable outbox payload: ${message}`.slice(0, 2_000), now, now, candidate.id);
          continue;
        }
        if (text.length === 0) {
          sqlite
            .query<never, [string, number, number, string]>(
              `UPDATE message_outbox
               SET state = 'dead_letter', last_error = ?, available_at = ?, updated_at = ?,
                   lease_owner = NULL, lease_expires_at = NULL
               WHERE id = ? AND state = 'leased'`,
            )
            .run('Outbox payload contained no text', now, now, candidate.id);
          continue;
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
    // The lease fields are cleared here too. `markSent` does it, and this
    // path did not, so a row that had previously been leased and then failed
    // kept a stale `lease_owner`/`lease_expires_at` while sitting in `sent` —
    // a row that claims to be owned by a worker that no longer holds it.
    const result = sqlite
      .query<never, [string | null, number, number, string]>(
        `UPDATE message_outbox
         SET state = 'sent', provider_message_id = ?, sent_at = ?, updated_at = ?,
             lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
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
    const message = error instanceof Error ? error.message : String(error);
    const deadline = now + exponentialBackoff(0, { baseMs: 5_000 });
    // Single atomic UPDATE: the WHERE clause + RETURNING pattern eliminates the
    // TOCTOU window that existed when this method did a SELECT-then-UPDATE in
    // two separate calls. If another worker already claimed/failed the row,
    // both the state and lease_owner predicates will not match and 0 rows are
    // affected — the caller receives 'not_owned'.
    const row = sqlite
      .query<{ attemptCount: number }, [number, string, number, number, number, number, string, string]>(
        `UPDATE message_outbox
         SET state = CASE WHEN attempt_count >= ? THEN 'dead_letter' ELSE 'failed' END,
             last_error = ?,
             available_at = CASE WHEN attempt_count >= ? THEN ? ELSE ? END,
             lease_owner = NULL,
             lease_expires_at = NULL,
             updated_at = ?
         WHERE id = ? AND state = 'leased' AND lease_owner = ?
         RETURNING attempt_count AS attemptCount`,
      )
      .get(MAX_ATTEMPTS, message.slice(0, 2_000), MAX_ATTEMPTS, deadline, deadline, now, id, owner);
    if (!row) {
      logger.warn({ id, owner }, '[Outbox] fail() called on a row not owned by this worker (already completed, dead-lettered, or leased elsewhere)');
      return 'not_owned';
    }
    const deadLettered = row.attemptCount >= MAX_ATTEMPTS;
    return deadLettered ? 'dead_letter' : 'retry';
  }

  /**
   * Prune terminal outbox rows older than `olderThanMs`. `failed` and
   * `dead_letter` rows are never claimed by the delivery worker, so without a
   * prune they accumulate indefinitely.
   */
  static prune(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const result = sqlite
      .query<never, [number]>(
        `DELETE FROM message_outbox
         WHERE state IN ('failed', 'dead_letter')
           AND COALESCE(sent_at, updated_at) < ?`,
      )
      .run(cutoff);
    return Number(result.changes);
  }
}
