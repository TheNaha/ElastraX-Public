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
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

// Path to the SQLite database file. Adjust via a future DB_PATH env var if needed.
const DB_PATH = './data/bot.db';

// Ensure the directory exists
const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

const sqlite = new Database(DB_PATH, { create: true });
// Enable Write-Ahead Logging (WAL) for better concurrent write performance
sqlite.exec('PRAGMA journal_mode = WAL;');
sqlite.exec('PRAGMA synchronous = NORMAL;');
export const db = drizzle({ client: sqlite, schema });
