import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import { resolveDatabasePath } from '../config/database.js';
import * as schema from './schema.js';
import {
  assertDatabaseIntegrity,
  getMigrationsFolder,
  fingerprintSchema,
  inspectMigrationState,
  readMigrationJournal,
  readStoredSchemaMeta,
  recordSchemaFingerprint,
  validateSchemaContract,
} from './migrations.js';
import {
  acquireDatabaseLease,
  ensureLeaseTable,
  isDatabaseLeaseActive,
  releaseDatabaseLease,
  renewDatabaseLease,
  type Lease,
} from './runtime.js';

export { withImmediateTransaction } from './runtime.js';
export * from './schema.js';

export type ElastraXDatabase = ReturnType<typeof drizzle<typeof schema>>;
export type SynchronousMode = 'OFF' | 'NORMAL' | 'FULL';

export interface DatabaseOptions {
  path?: string;
  busyTimeoutMs?: number;
  synchronous?: SynchronousMode;
  journalMode?: 'WAL' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'OFF';
}

export interface DatabaseHandle {
  sqlite: Database;
  db: ElastraXDatabase;
  path: string;
  close(): void;
  checkpoint(mode?: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'): void;
}

export interface EnsureDatabaseOptions {
  database?: DatabaseHandle;
  migrationsFolder?: string;
  leaseName?: string | null;
  leaseTtlMs?: number;
  owner?: string;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MIGRATION_LEASE = 'elastrax:migration';
const RUNTIME_LEASE = 'elastrax:runtime';
const readyHandles = new WeakSet<Database>();
const migratePromises = new WeakMap<Database, Promise<void>>();
const runtimeLeases = new WeakMap<Database, Lease>();
const leaseTimers = new WeakMap<Database, ReturnType<typeof setInterval>>();

/**
 * Callbacks invoked after a database schema migration completes.
 * Allows modules with schema-aware caches (e.g. room-key column detection)
 * to invalidate their caches so they pick up the new schema without requiring
 * a separate registration step or a circular import.
 */
export const afterMigrationCallbacks: Array<() => void> = [];

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function synchronousSetting(): SynchronousMode {
  const value = process.env.ELASTRAX_DB_SYNCHRONOUS?.trim().toUpperCase();
  if (value === 'OFF' || value === 'NORMAL' || value === 'FULL') return value;
  if (!value) return 'FULL';
  throw new Error('ELASTRAX_DB_SYNCHRONOUS must be OFF, NORMAL, or FULL');
}

function quotePragma(value: string): string {
  if (!/^[A-Z]+$/.test(value)) throw new Error(`Invalid SQLite PRAGMA value: ${value}`);
  return value;
}

function startLeaseHeartbeat(handle: DatabaseHandle, lease: Lease, ttlMs: number): void {
  // A thrown renewal (e.g. a transient SQLITE_BUSY, or one long event-loop
  // stall) used to close the database immediately and permanently
  // (`getDefaultHandle()` throws from then on), with no log line: the outbox
  // timer then logged 'Outbox worker failed' once a second while every inbound
  // message was dropped. A thrown error is treated as transient and only a
  // sustained run of them closes the handle.
  let consecutiveFailures = 0;
  // The threshold must outlast the lease TTL: the heartbeat runs every ttl/3, so
  // a fixed count of 3 fired at ~ttl and closed the handle just as a transient
  // stall was about to end. One extra interval gives the lease time to expire
  // first.
  const intervalMs = Math.max(1_000, Math.floor(ttlMs / 3));
  const maxTransientFailures = Math.max(3, Math.ceil(ttlMs / intervalMs) + 1);
  const timer = setInterval(() => {
    let renewed: Lease | null;
    try {
      renewed = renewDatabaseLease(handle.sqlite, lease, ttlMs);
    } catch (error) {
      consecutiveFailures += 1;
      logger.warn({ err: error, failures: consecutiveFailures }, '[db] Lease renewal failed; will retry');
      if (consecutiveFailures < maxTransientFailures) return;
      logger.error({ failures: consecutiveFailures }, '[db] Lease renewal kept failing; closing the database');
      closeDatabase(handle);
      return;
    }
    consecutiveFailures = 0;
    if (!renewed) {
      // The row expired or another owner took it. Closing is the correct
      // single-writer response, but it must be visible.
      logger.error({ lease: lease.name, owner: lease.owner }, '[db] Database lease was lost to another owner; closing this handle');
      closeDatabase(handle);
      return;
    }
    lease.expiresAt = renewed.expiresAt;
  }, intervalMs);
  timer.unref?.();
  leaseTimers.set(handle.sqlite, timer);
}

function createHandle(path: string, options: DatabaseOptions): DatabaseHandle {
  const inMemory = path === ':memory:';
  if (!inMemory && !existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path, { create: true, strict: true });
  const busyTimeoutMs = options.busyTimeoutMs
    ?? integerSetting('ELASTRAX_DB_BUSY_TIMEOUT_MS', DEFAULT_BUSY_TIMEOUT_MS, 0, 120_000);
  sqlite.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
  if (!inMemory) {
    sqlite.exec(`PRAGMA journal_mode = ${quotePragma(options.journalMode ?? 'WAL')}`);
  }
  sqlite.exec(`PRAGMA synchronous = ${quotePragma(options.synchronous ?? synchronousSetting())}`);
  sqlite.exec('PRAGMA wal_autocheckpoint = 1000');
  sqlite.exec('PRAGMA foreign_keys = ON');

  let closed = false;
  const handle: DatabaseHandle = {
    sqlite,
    db: drizzle({ client: sqlite, schema }),
    path,
    checkpoint(mode = 'TRUNCATE') {
      if (closed || inMemory) return;
      sqlite.exec(`PRAGMA wal_checkpoint(${quotePragma(mode)})`);
    },
    close() {
      if (closed) return;
      closed = true;
      const timer = leaseTimers.get(sqlite);
      if (timer) clearInterval(timer);
      leaseTimers.delete(sqlite);
      // The lease is released *last*. Releasing it first let the next process
      // acquire the database while this one still had it open and was running a
      // TRUNCATE checkpoint (which needs exclusive access) — the lease stopped
      // protecting the interval it exists for.
      const lease = runtimeLeases.get(sqlite);
      try {
        if (!inMemory) sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (error) {
        logger.warn({ err: error }, '[db] WAL checkpoint failed during close');
      }
      // Release after the checkpoint (which needs exclusive access) but before
      // `close()`, because releasing needs the open handle. The old order let the
      // next process acquire the database while this one was still holding it
      // through the checkpoint.
      if (lease) {
        try {
          releaseDatabaseLease(sqlite, lease);
        } catch (error) {
          logger.warn({ err: error }, '[db] Failed to release database lease during close');
        }
        runtimeLeases.delete(sqlite);
      }
      sqlite.close();
      readyHandles.delete(sqlite);
    },
  };
  return handle;
}

export function createDatabase(options: DatabaseOptions = {}): DatabaseHandle {
  return createHandle(options.path ?? resolveDatabasePath(), options);
}

let defaultHandle: DatabaseHandle | null = null;
let defaultClosed = false;

function getDefaultHandle(): DatabaseHandle {
  if (defaultClosed) throw new Error('The default database has been explicitly closed');
  if (!defaultHandle) {
    defaultHandle = createDatabase();
    defaultClosed = false;
  }
  return defaultHandle;
}

export function getDefaultDatabase(): DatabaseHandle {
  return getDefaultHandle();
}

export const db: ElastraXDatabase = new Proxy({} as ElastraXDatabase, {
  get(_target, property) {
    const actual = getDefaultHandle().db;
    const value = Reflect.get(actual, property, actual);
    return typeof value === 'function' ? value.bind(actual) : value;
  },
});

export const sqlite: Database = new Proxy({} as Database, {
  get(_target, property) {
    const handle = getDefaultHandle();
    if (property === 'close') return () => closeDatabase(handle);
    const value = Reflect.get(handle.sqlite, property, handle.sqlite);
    return typeof value === 'function' ? value.bind(handle.sqlite) : value;
  },
});

export function closeDatabase(handle?: DatabaseHandle): void {
  const target = handle ?? defaultHandle;
  if (!target) {
    defaultClosed = true;
    return;
  }
  if (target === defaultHandle) {
    defaultHandle = null;
    defaultClosed = true;
  }
  target.close();
}

function migrateHandle(
  handle: DatabaseHandle,
  options: EnsureDatabaseOptions,
): Promise<void> {
  const sqlite = handle.sqlite;
  const existing = migratePromises.get(sqlite);
  if (existing) return existing;

  const migrationsFolder = options.migrationsFolder ?? getMigrationsFolder();
  const leaseTtlMs = options.leaseTtlMs ?? 300_000;
  const leaseName = options.leaseName === undefined ? RUNTIME_LEASE : options.leaseName;
  let migrationLease: Lease | null = null;

  const promise = Promise.resolve().then(async () => {
    ensureLeaseTable(sqlite);
    inspectMigrationState(sqlite, migrationsFolder);
    if (handle.path !== ':memory:') {
      migrationLease = acquireDatabaseLease(sqlite, {
        name: MIGRATION_LEASE,
        owner: options.owner,
        ttlMs: leaseTtlMs,
      });
      if (!migrationLease) throw new Error('Another process is migrating or holding the database');
    }

    try {
      // The runtime lease only matters to a caller that is taking one. Tests and
      // the schema-compatibility checks pass `leaseName: null` explicitly, and a
      // live bot made even a read-only preflight fail on that check.
      if (leaseName !== null && isDatabaseLeaseActive(sqlite, RUNTIME_LEASE)) {
        throw new Error(`Database lease ${RUNTIME_LEASE} is held by another process`);
      }
      const before = inspectMigrationState(sqlite, migrationsFolder);
      // The fingerprint is a *cache* of the schema, not the schema itself. A
      // crash between drizzle's commit and recordSchemaFingerprint() left the
      // new schema stored under the old fingerprint; because the migrations were
      // already recorded as applied, every later boot found no pending
      // migrations and threw "fingerprint mismatch" forever - bricked, with
      // manual SQL as the only recovery. The stored migration count tells the
      // two cases apart: behind the journal means the crash window (re-record),
      // level with it means the schema changed with no migration (refuse).
      const stored = readStoredSchemaMeta(sqlite);
      if (stored) {
        const current = fingerprintSchema(sqlite);
        if (current !== stored.fingerprint) {
          if (stored.migrationCount >= before.applied.length) {
            throw new Error(
              `Database schema fingerprint mismatch: expected ${stored.fingerprint}, received ${current}. ` +
                'The schema changed without a matching migration; restore a backup or add the migration.',
            );
          }
          logger.warn(
            {
              path: handle.path,
              stored: stored.fingerprint,
              current,
              storedMigrations: stored.migrationCount,
              appliedMigrations: before.applied.length,
            },
            '[DB] Stored schema fingerprint was stale (migration was applied but not recorded); re-recording',
          );
        }
      }
      if (before.pending.length > 0) {
        assertDatabaseIntegrity(sqlite);
        migrate(handle.db, { migrationsFolder });
      }

      const after = inspectMigrationState(sqlite, migrationsFolder);
      validateSchemaContract(sqlite);
      // Invalidate schema-aware caches now that migrations may have added columns.
      for (const cb of afterMigrationCallbacks) {
        try { cb(); } catch (e) { logger.warn({ err: e }, 'Migration cache invalidation callback failed'); }
      }
      const fingerprint = recordSchemaFingerprint(
        sqlite,
        readMigrationJournal(migrationsFolder).at(-1)?.when ?? after.latestCreatedAt ?? 0,
        after.applied.length,
      );
      readyHandles.add(sqlite);
      logger.child({ module: 'DB' }).info(
        { path: handle.path, migrations: after.applied.length, fingerprint },
        'Database schema ensured',
      );

      // Take the runtime lease while the migration lease is still held. The old
      // order released the migration lease first and only then acquired the
      // runtime one, so another process could win the gap (or acquire during a
      // long `migrate()`): this process had already applied migrations and
      // recorded the fingerprint, and then failed to boot.
      if (leaseName !== null && handle.path !== ':memory:') {
        const lease = acquireDatabaseLease(sqlite, {
          name: leaseName,
          owner: options.owner,
          ttlMs: leaseTtlMs,
        });
        if (!lease) throw new Error(`Database lease ${leaseName} is held by another process`);
        runtimeLeases.set(sqlite, lease);
        startLeaseHeartbeat(handle, lease, leaseTtlMs);
      }
    } finally {
      if (migrationLease) releaseDatabaseLease(sqlite, migrationLease);
    }
  }).catch(error => {
    migratePromises.delete(sqlite);
    readyHandles.delete(sqlite);
    throw error;
  });

  migratePromises.set(sqlite, promise);
  return promise;
}

export function ensureDatabaseSchema(options: EnsureDatabaseOptions = {}): Promise<void> {
  return migrateHandle(options.database ?? getDefaultHandle(), options);
}

export function isSchemaReady(handle?: DatabaseHandle): boolean {
  return handle ? readyHandles.has(handle.sqlite) : defaultHandle !== null && readyHandles.has(defaultHandle.sqlite);
}
