/**
 * @file src/db/index.ts
 * @description Initialises and exports the shared Drizzle ORM database instance.
 *
 * The database file is stored at `./data/bot.db` relative to the working directory.
 * The `data/` directory is created automatically if it does not yet exist so that
 * first-run setup requires no manual steps.
 *
 * SQLite pragmas applied at open time:
 *  - `journal_mode = WAL` — Write-Ahead Logging allows concurrent reads during writes,
 *    which is important because providers and the agent may access the DB simultaneously.
 *  - `synchronous = NORMAL` — Balances durability against write throughput; safe for
 *    a bot workload where losing the very last message on a crash is acceptable.
 *
 * The exported `db` object should be imported directly by all modules that need
 * database access — no connection pool or factory is required for SQLite.
 */

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { ROOT_DIR } from '../core/constants.js';
import * as schema from './schema.js';

const DEFAULT_DB_PATH = join(ROOT_DIR, 'data/bot.db');
const DB_PATH = process.env.ELASTRAX_DB_PATH?.trim() || DEFAULT_DB_PATH;
const usesInMemoryDb = DB_PATH === ':memory:';

// Ensure the directory exists
const dir = dirname(DB_PATH);
if (!usesInMemoryDb && !existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

export const sqlite = new Database(DB_PATH, { create: true, strict: true });
// Enable Write-Ahead Logging (WAL) for better concurrent write performance.
// WAL is an in-place database operation; it completes quickly for most DBs.
// For very large databases (>1GB), consider running this once manually.
if (!usesInMemoryDb) {
  sqlite.exec('PRAGMA journal_mode = WAL;');
}
sqlite.exec('PRAGMA synchronous = NORMAL;');
sqlite.exec('PRAGMA foreign_keys = ON;');
export const db = drizzle({ client: sqlite, schema });

let schemaInitialized = false;
let migratePromise: Promise<void> | null = null;

/**
 * Apply pending Drizzle migrations. Returns a Promise that resolves once
 * migrations are complete. Safe to call from multiple places — concurrent
 * callers share the same underlying promise.
 *
 * Migrations run via the synchronous `bun:sqlite` driver; for large databases
 * this may briefly block the event loop, but only once at startup.
 */
export function ensureDatabaseSchema(): Promise<void> {
  if (migratePromise) return migratePromise;

  migratePromise = Promise.resolve().then(() => {
    migrate(db, { migrationsFolder: join(ROOT_DIR, 'drizzle/migrations') });
    schemaInitialized = true;
    const log = logger.child({ module: 'DB' });
    log.info('Database schema ensured (migrations applied if any)');
  });

  return migratePromise;
}

/** Whether `ensureDatabaseSchema()` has completed (resolved or rejected). */
export function isSchemaReady(): boolean {
  return schemaInitialized;
}
