import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

export interface LeaseOptions {
  name: string;
  owner?: string;
  ttlMs?: number;
  now?: number;
}

export interface Lease {
  name: string;
  owner: string;
  expiresAt: number;
}

export interface InboxEventInput {
  platform: string;
  chatRoomId: string;
  roomKey?: string | null;
  providerMessageId?: string | null;
  eventKey: string;
  payload?: string | null;
  now?: number;
  availableAt?: number;
}

export interface OutboxMessageInput {
  id?: string;
  platform: string;
  chatRoomId: string;
  roomKey?: string | null;
  idempotencyKey: string;
  payload: string;
  now?: number;
  availableAt?: number;
}

export interface ScheduledDeliveryInput {
  id?: string;
  platform: string;
  jobKey: string;
  chatRoomId: string;
  roomKey?: string | null;
  payload: string;
  scheduledAt: number;
  now?: number;
  availableAt?: number;
}

export interface ClaimedInbox {
  id: number;
  platform: string;
  chatRoomId: string;
  roomKey: string | null;
  eventKey: string;
  payload: string | null;
  attemptCount: number;
}

export interface ClaimedDelivery {
  id: string;
  platform: string;
  chatRoomId: string;
  roomKey: string | null;
  payload: string;
  attemptCount: number;
}

function defaultOwner(): string {
  return `${process.pid}:${randomUUID()}`;
}

export function ensureLeaseTable(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS database_leases (
      name TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

export function acquireDatabaseLease(sqlite: Database, options: LeaseOptions): Lease | null {
  ensureLeaseTable(sqlite);
  const now = options.now ?? Date.now();
  const owner = options.owner ?? defaultOwner();
  const ttlMs = Math.max(1_000, options.ttlMs ?? 30_000);
  const expiresAt = now + ttlMs;
  const result = sqlite
    .query<never, [string, string, number, number, number, string]>(
      `INSERT INTO database_leases (name, owner, expires_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         owner = excluded.owner,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       WHERE database_leases.expires_at <= ? OR database_leases.owner = ?`,
    )
    .run(options.name, owner, expiresAt, now, now, owner);
  if (Number(result.changes) !== 1) return null;
  return { name: options.name, owner, expiresAt };
}

export function renewDatabaseLease(
  sqlite: Database,
  lease: Lease,
  ttlMs = 30_000,
  now = Date.now(),
): Lease | null {
  const expiresAt = now + Math.max(1_000, ttlMs);
  const result = sqlite
    .query<never, [number, number, string, string, number]>(
      `UPDATE database_leases
       SET expires_at = ?, updated_at = ?
       WHERE name = ? AND owner = ? AND expires_at > ?`,
    )
    .run(expiresAt, now, lease.name, lease.owner, now);
  if (Number(result.changes) !== 1) return null;
  return { ...lease, expiresAt };
}

export function isDatabaseLeaseActive(
  sqlite: Database,
  name: string,
  now = Date.now(),
): boolean {
  ensureLeaseTable(sqlite);
  const row = sqlite
    .query<{ active: number }, [string, number]>(
      'SELECT 1 AS active FROM database_leases WHERE name = ? AND expires_at > ? LIMIT 1',
    )
    .get(name, now);
  return row !== null;
}

export function releaseDatabaseLease(sqlite: Database, lease: Lease): boolean {
  const result = sqlite
    .query<never, [string, string]>(
      'DELETE FROM database_leases WHERE name = ? AND owner = ?',
    )
    .run(lease.name, lease.owner);
  return Number(result.changes) === 1;
}

export function withImmediateTransaction<T>(sqlite: Database, operation: () => T): T {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      sqlite.exec('ROLLBACK');
    } catch (rollbackError) {
      void rollbackError;
    }
    throw error;
  }
}

export function enqueueInboxEvent(sqlite: Database, input: InboxEventInput): number {
  const now = input.now ?? Date.now();
  const row = sqlite
    .query<{ id: number }, [string, string, string | null, string | null, string, string | null, number, number, number, number]>(
      `INSERT INTO message_inbox
         (platform, chat_room_id, room_key, provider_message_id, event_key, payload, received_at, available_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(platform, event_key) DO UPDATE SET
         payload = CASE WHEN message_inbox.state = 'received' THEN excluded.payload ELSE message_inbox.payload END,
         room_key = COALESCE(excluded.room_key, message_inbox.room_key),
         updated_at = excluded.updated_at
       RETURNING id`,
    )
    .get(
      input.platform,
      input.chatRoomId,
      input.roomKey ?? null,
      input.providerMessageId ?? null,
      input.eventKey,
      input.payload ?? null,
      now,
      input.availableAt ?? now,
      now,
      now,
    );
  if (!row) throw new Error('Failed to enqueue inbox event');
  return Number(row.id);
}

export function claimInboxEvents(
  sqlite: Database,
  owner: string,
  options: { now?: number; limit?: number; leaseMs?: number } = {},
): ClaimedInbox[] {
  const now = options.now ?? Date.now();
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 50)));
  return withImmediateTransaction(sqlite, () => {
    const candidates = sqlite
      .query<{ id: number }, [number, number, number]>(
        `SELECT id FROM message_inbox
         WHERE available_at <= ?
           AND (state IN ('received', 'failed') OR (state = 'processing' AND lease_expires_at <= ?))
         ORDER BY available_at, received_at
         LIMIT ?`,
      )
      .all(now, now, limit);
    const claimed: ClaimedInbox[] = [];
    for (const candidate of candidates) {
      const result = sqlite
        .query<never, [string, number, number, number, number, number]>(
          `UPDATE message_inbox
           SET state = 'processing', lease_owner = ?, lease_expires_at = ?,
               attempt_count = attempt_count + 1, updated_at = ?
           WHERE id = ?
             AND available_at <= ?
             AND (state IN ('received', 'failed') OR (state = 'processing' AND lease_expires_at <= ?))`,
        )
        .run(owner, now + Math.max(1_000, options.leaseMs ?? 120_000), now, candidate.id, now, now);
      if (Number(result.changes) !== 1) continue;
      const row = sqlite
        .query<ClaimedInbox, [number]>(
          `SELECT id, platform, chat_room_id AS chatRoomId, room_key AS roomKey, event_key AS eventKey,
                  payload, attempt_count AS attemptCount
           FROM message_inbox WHERE id = ?`,
        )
        .get(candidate.id);
      if (row) claimed.push(row);
    }
    return claimed;
  });
}

export function markInboxCompleted(
  sqlite: Database,
  id: number,
  owner: string,
  now = Date.now(),
): boolean {
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

export function releaseFailedInbox(
  sqlite: Database,
  id: number,
  owner: string,
  error: string,
  retryAt: number,
  maxAttempts: number,
  now = Date.now(),
): 'retry' | 'dead_letter' | 'not_owned' {
  return withImmediateTransaction(sqlite, () => {
    const row = sqlite
      .query<{ attempt_count: number }, [number, string]>(
        'SELECT attempt_count FROM message_inbox WHERE id = ? AND state = \'processing\' AND lease_owner = ?',
      )
      .get(id, owner);
    if (!row) return 'not_owned';
    const state: 'retry' | 'dead_letter' = Number(row.attempt_count) >= Math.max(1, maxAttempts) ? 'dead_letter' : 'retry';
    sqlite
      .query<never, [string, string, number, number, number, string]>(
        `UPDATE message_inbox
         SET state = ?, last_error = ?, available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'processing' AND lease_owner = ?`,
      )
      .run(state, error.slice(0, 2_000), retryAt, now, id, owner);
    return state;
  });
}

export function enqueueOutboxMessage(sqlite: Database, input: OutboxMessageInput): string {
  const now = input.now ?? Date.now();
  const id = input.id ?? randomUUID();
  const row = sqlite
    .query<{ id: string }, [string, string, string, string | null, string, string, number, number, number]>(
      `INSERT INTO message_outbox
         (id, platform, chat_room_id, room_key, idempotency_key, payload, available_at, created_at, updated_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(platform, idempotency_key) DO UPDATE SET
         payload = CASE WHEN message_outbox.state IN ('failed', 'pending') THEN excluded.payload ELSE message_outbox.payload END,
         room_key = COALESCE(excluded.room_key, message_outbox.room_key),
         updated_at = excluded.updated_at
       RETURNING id`,
    )
    .get(
      id,
      input.platform,
      input.chatRoomId,
      input.roomKey ?? null,
      input.idempotencyKey,
      input.payload,
      input.availableAt ?? now,
      now,
      now,
    );
  if (!row) throw new Error('Failed to enqueue outbox message');
  return row.id;
}

export function enqueueScheduledDelivery(sqlite: Database, input: ScheduledDeliveryInput): string {
  const now = input.now ?? Date.now();
  const id = input.id ?? randomUUID();
  const row = sqlite
    .query<{ id: string }, [string, string, string, string, string | null, string, number, number, number, number]>(
      `INSERT INTO scheduled_deliveries
         (id, platform, job_key, chat_room_id, room_key, payload, scheduled_at, available_at, created_at, updated_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(platform, job_key) DO UPDATE SET
         payload = CASE WHEN scheduled_deliveries.state IN ('failed', 'pending') THEN excluded.payload ELSE scheduled_deliveries.payload END,
         room_key = COALESCE(excluded.room_key, scheduled_deliveries.room_key),
         scheduled_at = CASE WHEN scheduled_deliveries.state IN ('failed', 'pending') THEN excluded.scheduled_at ELSE scheduled_deliveries.scheduled_at END,
         available_at = CASE WHEN scheduled_deliveries.state IN ('failed', 'pending') THEN excluded.available_at ELSE scheduled_deliveries.available_at END,
         updated_at = excluded.updated_at
       RETURNING id`,
    )
    .get(
      id,
      input.platform,
      input.jobKey,
      input.chatRoomId,
      input.roomKey ?? null,
      input.payload,
      input.scheduledAt,
      input.availableAt ?? input.scheduledAt,
      now,
      now,
    );
  if (!row) throw new Error('Failed to enqueue scheduled delivery');
  return row.id;
}

function claimRows(
  sqlite: Database,
  table: 'message_outbox' | 'scheduled_deliveries',
  owner: string,
  now: number,
  limit: number,
  leaseMs: number,
  requireScheduledAt: boolean,
): ClaimedDelivery[] {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  return withImmediateTransaction(sqlite, () => {
    const candidateSql = `SELECT id FROM ${table}
         WHERE available_at <= ?
           AND (state IN ('pending', 'failed') OR (state = 'leased' AND lease_expires_at <= ?))
           ${requireScheduledAt ? 'AND scheduled_at <= ?' : ''}
         ORDER BY ${requireScheduledAt ? 'scheduled_at, created_at' : 'available_at, created_at'}
         LIMIT ?`;
    const candidates = (requireScheduledAt
      ? sqlite.query<{ id: string }, [number, number, number, number]>(candidateSql).all(now, now, now, safeLimit)
      : sqlite.query<{ id: string }, [number, number, number]>(candidateSql).all(now, now, safeLimit)) as Array<{ id: string }>;

    const claimed: ClaimedDelivery[] = [];
    for (const candidate of candidates) {
      const result = sqlite
        .query<never, [string, number, number, string, number, number]>(
          `UPDATE ${table}
           SET state = 'leased', lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
           WHERE id = ?
             AND available_at <= ?
             AND (state IN ('pending', 'failed') OR (state = 'leased' AND lease_expires_at <= ?))`,
        )
        .run(owner, now + Math.max(1_000, leaseMs), now, candidate.id, now, now);
      if (Number(result.changes) !== 1) continue;
      const row = sqlite
        .query<ClaimedDelivery, [string]>(
          `SELECT id, platform, chat_room_id AS chatRoomId, room_key AS roomKey,
                  payload, attempt_count AS attemptCount FROM ${table} WHERE id = ?`,
        )
        .get(candidate.id);
      if (row) claimed.push(row);
    }
    return claimed;
  });
}

export function claimOutboxMessages(
  sqlite: Database,
  owner: string,
  options: { now?: number; limit?: number; leaseMs?: number } = {},
): ClaimedDelivery[] {
  const now = options.now ?? Date.now();
  return claimRows(sqlite, 'message_outbox', owner, now, options.limit ?? 50, options.leaseMs ?? 120_000, false);
}

export function claimScheduledDeliveries(
  sqlite: Database,
  owner: string,
  options: { now?: number; limit?: number; leaseMs?: number } = {},
): ClaimedDelivery[] {
  const now = options.now ?? Date.now();
  return claimRows(
    sqlite,
    'scheduled_deliveries',
    owner,
    now,
    options.limit ?? 50,
    options.leaseMs ?? 120_000,
    true,
  );
}

export function markDeliverySent(
  sqlite: Database,
  table: 'message_outbox' | 'scheduled_deliveries',
  id: string,
  owner: string,
  providerMessageId: string | null,
  now = Date.now(),
): boolean {
  const result = sqlite
    .query<never, [string | null, number, number, string, string]>(
      `UPDATE ${table}
       SET state = 'sent', provider_message_id = ?, sent_at = ?, lease_owner = NULL,
           lease_expires_at = NULL, last_error = NULL, updated_at = ?
       WHERE id = ? AND state = 'leased' AND lease_owner = ?`,
    )
    .run(providerMessageId, now, now, id, owner);
  return Number(result.changes) === 1;
}

export function releaseFailedDelivery(
  sqlite: Database,
  table: 'message_outbox' | 'scheduled_deliveries',
  id: string,
  owner: string,
  error: string,
  retryAt: number,
  maxAttempts: number,
  now = Date.now(),
): 'retry' | 'dead_letter' | 'not_owned' {
  return withImmediateTransaction(sqlite, () => {
    const row = sqlite
      .query<{ attempt_count: number }, [string, string]>(
        `SELECT attempt_count FROM ${table} WHERE id = ? AND state = 'leased' AND lease_owner = ?`,
      )
      .get(id, owner);
    if (!row) return 'not_owned';
    const state: 'retry' | 'dead_letter' = Number(row.attempt_count) >= Math.max(1, maxAttempts) ? 'dead_letter' : 'retry';
    sqlite
      .query<never, [string, string, number, number, string, string]>(
        `UPDATE ${table}
         SET state = ?, last_error = ?, available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'leased' AND lease_owner = ?`,
      )
      .run(state, error.slice(0, 2_000), retryAt, now, id, owner);
    return state;
  });
}

export function recordIdentityAliases(
  sqlite: Database,
  input: {
    canonicalId: string;
    platform: string;
    primaryAlias: string;
    aliases: Array<{ value: string; kind: string }>;
    displayName?: string | null;
    now?: number;
  },
): void {
  if (!input.canonicalId || !input.platform || !input.primaryAlias) {
    throw new Error('Canonical identity, platform, and primary alias are required');
  }
  const now = input.now ?? Date.now();
  withImmediateTransaction(sqlite, () => {
    sqlite
      .query<never, [string, string, string, string | null, number, number]>(
        `INSERT INTO canonical_identities
           (id, platform, primary_alias, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, canonical_identities.display_name),
           updated_at = excluded.updated_at`,
      )
      .run(input.canonicalId, input.platform, input.primaryAlias, input.displayName ?? null, now, now);

    for (const alias of new Map([{ value: input.primaryAlias, kind: 'primary' }, ...input.aliases].map(item => [item.value, item])).values()) {
      const existing = sqlite
        .query<{ canonical_id: string }, [string, string]>(
          'SELECT canonical_id FROM identity_aliases WHERE platform = ? AND alias = ?',
        )
        .get(input.platform, alias.value);
      if (existing && existing.canonical_id !== input.canonicalId) {
        throw new Error(`Identity alias ${alias.value} already belongs to another canonical identity`);
      }
      sqlite
        .query<never, [string, string, string, string, number, number]>(
          `INSERT INTO identity_aliases
             (canonical_id, platform, alias, alias_kind, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(platform, alias) DO UPDATE SET
             alias_kind = excluded.alias_kind,
             last_seen_at = excluded.last_seen_at`,
        )
        .run(input.canonicalId, input.platform, alias.value, alias.kind, now, now);
    }

    for (const alias of input.aliases) {
      sqlite
        .query<never, [string | null, string, string, string]>(
          `UPDATE user_identities SET canonical_id = ?
           WHERE platform = ? AND (lid = ? OR pn = ?)`,
        )
        .run(input.canonicalId, input.platform, alias.value, alias.value);
    }
  });
}
