import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

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
