/**
 * @file src/db/runtime.ts
 * @description Low-level SQL helpers for the durable messaging tables.
 *
 * The production inbox/outbox lives in `src/messaging/InboxService.ts` and
 * `src/messaging/OutboxService.ts`. This module retains only the single-instance
 * database lease and the immediate-transaction helper used by schema initialization,
 * room-key resolution, and outbox delivery. The second inbox/outbox implementation
 * that used to live here (with different claim/enqueue semantics) has been removed
 * to eliminate the duplicated state machine.
 */
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

function defaultOwner(): string {
  return `${process.pid}:${randomUUID()}`;
}

/**
 * Ensure the `database_leases` table exists.
 *
 * This mirrors the schema in migration `0021_database_safety.sql` and is kept
 * here as a defensive fallback for databases that have not yet been migrated
 * to 0021 (or for test databases that skip migrations). The `IF NOT EXISTS`
 * guard makes this idempotent: on a migrated database the exec is a no-op.
 *
 * Keep the two definitions in sync.
 */
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
    if (result instanceof Promise) {
      sqlite.exec('ROLLBACK');
      throw new TypeError(
        'withImmediateTransaction: operation returned a Promise — the callback is synchronous. '
        + 'Use an async wrapper or restructure to avoid awaiting inside.',
      );
    }
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
