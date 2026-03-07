import { beforeEach, describe, expect, mock, test } from 'bun:test';

const sqliteExecCalls: string[] = [];
const dbPaths: string[] = [];
const mkdirCalls: Array<{ path: string; recursive?: boolean }> = [];
const migrateCalls: Array<{ folder: string }> = [];
const existingPaths = new Set<string>();

class MockDatabase {
  constructor(path: string) {
    dbPaths.push(path);
  }

  exec(sql: string): void {
    sqliteExecCalls.push(sql);
  }
}

mock.module('bun:sqlite', () => ({ Database: MockDatabase }));
mock.module('drizzle-orm/bun-sqlite', () => ({ drizzle: ({ client, schema }: { client: unknown; schema: unknown }) => ({ client, schema }) }));
mock.module('drizzle-orm/bun-sqlite/migrator', () => ({ migrate: (_db: unknown, options: { migrationsFolder: string }) => migrateCalls.push({ folder: options.migrationsFolder }) }));
mock.module('node:fs', () => ({
  existsSync: (path: string) => existingPaths.has(path),
  mkdirSync: (path: string, options?: { recursive?: boolean }) => {
    mkdirCalls.push({ path, recursive: options?.recursive });
    existingPaths.add(path);
  },
}));

async function importFreshDbModule(label: string) {
  return import(`../src/db/index.ts?case=${label}-${Date.now()}`);
}

describe('db/index', () => {
  beforeEach(() => {
    sqliteExecCalls.length = 0;
    dbPaths.length = 0;
    mkdirCalls.length = 0;
    migrateCalls.length = 0;
    existingPaths.clear();
    delete process.env.ELASTRAX_DB_PATH;
  });

  test('creates the data directory, enables pragmas, and migrates once for file databases', async () => {
    const mod = await importFreshDbModule('file');

    expect(dbPaths).toEqual(['./data/bot.db']);
    expect(mkdirCalls).toEqual([{ path: './data', recursive: true }]);
    expect(sqliteExecCalls).toContain('PRAGMA journal_mode = WAL;');
    expect(sqliteExecCalls).toContain('PRAGMA synchronous = NORMAL;');
    expect(sqliteExecCalls).toContain('PRAGMA foreign_keys = ON;');

    mod.ensureDatabaseSchema();
    mod.ensureDatabaseSchema();
    expect(migrateCalls).toEqual([{ folder: './drizzle/migrations' }]);
  });

  test('skips directory creation and WAL for in-memory databases', async () => {
    process.env.ELASTRAX_DB_PATH = ':memory:';
    await importFreshDbModule('memory');

    expect(dbPaths).toEqual([':memory:']);
    expect(mkdirCalls).toEqual([]);
    expect(sqliteExecCalls).not.toContain('PRAGMA journal_mode = WAL;');
    expect(sqliteExecCalls).toContain('PRAGMA synchronous = NORMAL;');
    expect(sqliteExecCalls).toContain('PRAGMA foreign_keys = ON;');
  });

  test('does not recreate an existing directory', async () => {
    existingPaths.add('./data');
    await importFreshDbModule('existing-dir');

    expect(mkdirCalls).toEqual([]);
  });

  test('uses trimmed ELASTRAX_DB_PATH values', async () => {
    process.env.ELASTRAX_DB_PATH = '  ./tmp/custom.db  ';
    await importFreshDbModule('trimmed-path');

    expect(dbPaths).toEqual(['./tmp/custom.db']);
    expect(mkdirCalls).toEqual([{ path: './tmp', recursive: true }]);
  });
});