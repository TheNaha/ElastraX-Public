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
import { dirname } from 'node:path';
import * as schema from './schema.js';

const DEFAULT_DB_PATH = './data/bot.db';
const DB_PATH = process.env.ELASTRAX_DB_PATH?.trim() || DEFAULT_DB_PATH;
const usesInMemoryDb = DB_PATH === ':memory:';

// Ensure the directory exists
const dir = dirname(DB_PATH);
if (!usesInMemoryDb && !existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

export const sqlite = new Database(DB_PATH, { create: true });
// Enable Write-Ahead Logging (WAL) for better concurrent write performance
if (!usesInMemoryDb) {
  sqlite.exec('PRAGMA journal_mode = WAL;');
}
sqlite.exec('PRAGMA synchronous = NORMAL;');
sqlite.exec('PRAGMA foreign_keys = ON;');
export const db = drizzle({ client: sqlite, schema });

let schemaInitialized = false;

export function ensureDatabaseSchema(): void {
  if (schemaInitialized) return;
  migrate(db, { migrationsFolder: './drizzle/migrations' });
  schemaInitialized = true;
}
