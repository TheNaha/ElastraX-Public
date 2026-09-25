import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function importFreshDbModule(label: string): Promise<typeof import('../src/db/index')> {
  return import(`../src/db/index.ts?case=${label}-${Date.now()}`);
}

describe('db/index', () => {
  let tmpDir: string;
  const savedDbPath = process.env.ELASTRAX_DB_PATH;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `elastrax-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    delete process.env.ELASTRAX_DB_PATH;
  });

  afterEach(() => {
    if (savedDbPath !== undefined) process.env.ELASTRAX_DB_PATH = savedDbPath;
    else delete process.env.ELASTRAX_DB_PATH;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch (error) {
      void error;
    }
  });

  test('does not open a file until the first database operation', async () => {
    const dbPath = join(tmpDir, 'lazy.db');
    process.env.ELASTRAX_DB_PATH = dbPath;
    const mod = await importFreshDbModule('lazy');

    expect(existsSync(tmpDir)).toBe(false);
    expect(mod.isSchemaReady()).toBe(false);
    expect(existsSync(dbPath)).toBe(false);

    const journalMode = mod.sqlite.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    expect(journalMode?.journal_mode).toBe('wal');
    expect(existsSync(dbPath)).toBe(true);
    mod.closeDatabase();
  });

  test('configures durability, busy timeout, and foreign keys', async () => {
    const dbPath = join(tmpDir, 'pragmas.db');
    process.env.ELASTRAX_DB_PATH = dbPath;
    const mod = await importFreshDbModule('pragmas');
    mod.sqlite.exec('SELECT 1');

    expect(mod.sqlite.query<{ synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous).toBe(2);
    expect(mod.sqlite.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()?.timeout).toBe(5_000);
    expect(mod.sqlite.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    mod.closeDatabase();
  });

  test('supports in-memory databases without filesystem side effects', async () => {
    process.env.ELASTRAX_DB_PATH = ':memory:';
    const mod = await importFreshDbModule('memory');
    mod.sqlite.exec('SELECT 1');

    expect(mod.sqlite.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode).not.toBe('wal');
    expect(existsSync(tmpDir)).toBe(false);
    mod.closeDatabase();
  });

  test('supports injected handles and explicit close', async () => {
    process.env.ELASTRAX_DB_PATH = join(tmpDir, 'default-must-not-open.db');
    const mod = await importFreshDbModule('injected');
    const handle = mod.createDatabase({ path: ':memory:', busyTimeoutMs: 1_234, synchronous: 'NORMAL' });

    expect(handle.sqlite.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()?.timeout).toBe(1_234);
    expect(handle.sqlite.query<{ synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous).toBe(1);
    handle.close();
    expect(() => handle.sqlite.exec('SELECT 1')).toThrow();

    mod.closeDatabase();
    expect(() => mod.sqlite.exec('SELECT 1')).toThrow('explicitly closed');
    expect(existsSync(join(tmpDir, 'default-must-not-open.db'))).toBe(false);
  });

  test('enforces a renewable runtime lease across injected handles', async () => {
    process.env.ELASTRAX_DB_PATH = join(tmpDir, 'leased.db');
    const mod = await importFreshDbModule('lease');
    const first = mod.createDatabase({ path: join(tmpDir, 'leased.db') });
    const second = mod.createDatabase({ path: first.path });

    try {
      await mod.ensureDatabaseSchema({ database: first });
      await expect(mod.ensureDatabaseSchema({ database: second, leaseName: 'runtime-test' })).rejects.toThrow('held by another process');
    } finally {
      first.close();
    }

    try {
      await mod.ensureDatabaseSchema({ database: second, leaseName: 'runtime-test' });
      expect(second.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM database_leases WHERE name = 'runtime-test'").get()?.count).toBe(1);
    } finally {
      second.close();
      mod.closeDatabase();
    }
  });

  test('trims and resolves ELASTRAX_DB_PATH values', async () => {
    const dbPath = join(tmpDir, 'trimmed.db');
    process.env.ELASTRAX_DB_PATH = `  ${dbPath}  `;
    const mod = await importFreshDbModule('trimmed');

    expect(mod.getDefaultDatabase().path).toBe(dbPath);
    mod.closeDatabase();
  });
});
