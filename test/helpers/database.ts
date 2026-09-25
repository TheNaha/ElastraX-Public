import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as schema from '../../src/db/schema';
import { assertSafeDatabasePath, getTestWorkerPaths, REPOSITORY_ROOT } from './paths';

export interface TempDatabaseOptions {
  memory?: boolean;
  migrate?: boolean;
  fileName?: string;
}

export interface TempDatabase {
  path: string;
  sqlite: Database;
  db: ReturnType<typeof drizzle<typeof schema>>;
  cleanup(): void;
}

export function createTempDatabasePath(fileName = `db-${randomUUID()}.db`): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '-');
  const normalizedName = safeName === '.' || safeName === '..' ? `db-${randomUUID()}.db` : safeName;
  const path = join(getTestWorkerPaths().root, 'db', normalizedName);
  assertSafeDatabasePath(path);
  return path;
}

export function ensureTempDatabaseSchema(path = getTestWorkerPaths().dbPath): void {
  assertSafeDatabasePath(path);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = new Database(path, { create: true, strict: true });
  try {
    sqlite.exec('PRAGMA foreign_keys = ON;');
    const db = drizzle({ client: sqlite, schema });
    migrate(db, { migrationsFolder: join(REPOSITORY_ROOT, 'drizzle', 'migrations') });
  } finally {
    sqlite.close();
  }
}

export function createTempDatabase(options: TempDatabaseOptions = {}): TempDatabase {
  const path = options.memory ? ':memory:' : createTempDatabasePath(options.fileName);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const db = drizzle({ client: sqlite, schema });
  if (options.migrate !== false) {
    try {
      migrate(db, { migrationsFolder: join(REPOSITORY_ROOT, 'drizzle', 'migrations') });
    } catch (error) {
      sqlite.close();
      if (path !== ':memory:') rmSync(path, { force: true });
      for (const suffix of ['-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
      throw error;
    }
  }
  let closed = false;
  return {
    path,
    sqlite,
    db,
    cleanup() {
      if (closed) return;
      closed = true;
      sqlite.close();
      if (path !== ':memory:') rmSync(path, { force: true });
      for (const suffix of ['-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    },
  };
}

export async function withTempDatabase<T>(
  callback: (database: TempDatabase) => T | Promise<T>,
  options: TempDatabaseOptions = {},
): Promise<T> {
  const database = createTempDatabase(options);
  try {
    return await callback(database);
  } finally {
    database.cleanup();
  }
}

export const withTempDb = withTempDatabase;

export async function importFreshDatabaseModule(label = 'isolated'): Promise<{
  module: typeof import('../../src/db/index.ts');
  path: string;
  cleanup(): void;
}> {
  const path = createTempDatabasePath(`fresh-${label.replace(/[^a-zA-Z0-9_-]/g, '-')}-${randomUUID().slice(0, 8)}.db`);
  const previousPath = process.env.ELASTRAX_DB_PATH;
  process.env.ELASTRAX_DB_PATH = path;
  let module: typeof import('../../src/db/index.ts');
  try {
    module = await import(`../../src/db/index.ts?harness=${encodeURIComponent(`${label}-${randomUUID()}`)}`);
  } catch (error) {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    if (previousPath === undefined) delete process.env.ELASTRAX_DB_PATH;
    else process.env.ELASTRAX_DB_PATH = previousPath;
    throw error;
  }
  let closed = false;
  return {
    module,
    path,
    cleanup() {
      if (closed) return;
      closed = true;
      module.sqlite.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      if (previousPath === undefined) delete process.env.ELASTRAX_DB_PATH;
      else process.env.ELASTRAX_DB_PATH = previousPath;
    },
  };
}

export async function withFreshDatabase<T>(
  callback: (module: typeof import('../../src/db/index.ts')) => T | Promise<T>,
  label = 'isolated',
): Promise<T> {
  const handle = await importFreshDatabaseModule(label);
  try {
    return await callback(handle.module);
  } finally {
    handle.cleanup();
  }
}
