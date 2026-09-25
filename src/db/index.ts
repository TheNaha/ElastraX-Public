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
  inspectMigrationState,
  readMigrationJournal,
  recordSchemaFingerprint,
  validateSchemaContract,
  verifyStoredSchemaFingerprint,
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
  const timer = setInterval(() => {
    try {
      const renewed = renewDatabaseLease(handle.sqlite, lease, ttlMs);
      if (!renewed) {
        closeDatabase(handle);
        return;
      }
      lease.expiresAt = renewed.expiresAt;
    } catch {
      closeDatabase(handle);
    }
  }, Math.max(1_000, Math.floor(ttlMs / 3)));
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
      const lease = runtimeLeases.get(sqlite);
      if (lease) {
        try {
          releaseDatabaseLease(sqlite, lease);
        } catch (error) {
          void error;
        }
        runtimeLeases.delete(sqlite);
      }
      try {
        if (!inMemory) sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (error) {
        void error;
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
      if (isDatabaseLeaseActive(sqlite, RUNTIME_LEASE)) {
        throw new Error(`Database lease ${RUNTIME_LEASE} is held by another process`);
      }
      const before = inspectMigrationState(sqlite, migrationsFolder);
      verifyStoredSchemaFingerprint(sqlite);
      if (before.pending.length > 0) {
        assertDatabaseIntegrity(sqlite);
        migrate(handle.db, { migrationsFolder });
      }

      const after = inspectMigrationState(sqlite, migrationsFolder);
      validateSchemaContract(sqlite);
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
    } finally {
      if (migrationLease) releaseDatabaseLease(sqlite, migrationLease);
    }

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
