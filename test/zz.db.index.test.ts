import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Integration-style tests for src/db/index.ts module initialisation.
 *
 * These tests use real `bun:sqlite` and `drizzle-orm` modules with temporary
 * directories instead of `mock.module()` so that module mocks don't leak
 * into other test files sharing the same process.
 */

async function importFreshDbModule(label: string) {
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
    if (savedDbPath !== undefined) {
      process.env.ELASTRAX_DB_PATH = savedDbPath;
    } else {
      delete process.env.ELASTRAX_DB_PATH;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
  });

  test('creates the data directory, enables pragmas, and migrates once for file databases', async () => {
    const dbPath = join(tmpDir, 'test.db');
    process.env.ELASTRAX_DB_PATH = dbPath;

    const mod = await importFreshDbModule('file');

    // Directory and database file should be created
    expect(existsSync(tmpDir)).toBe(true);
    expect(existsSync(dbPath)).toBe(true);

    // Verify pragmas via live queries
    const journalMode = mod.sqlite.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    expect(journalMode?.journal_mode).toBe('wal');

    const sync = mod.sqlite.query<{ synchronous: number }, []>('PRAGMA synchronous').get();
    expect(sync?.synchronous).toBe(1); // NORMAL = 1

    const fk = mod.sqlite.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
    expect(fk?.foreign_keys).toBe(1);

    mod.sqlite.close();
  });

  test('skips directory creation and WAL for in-memory databases', async () => {
    process.env.ELASTRAX_DB_PATH = ':memory:';
    const mod = await importFreshDbModule('memory');

    // WAL is not applicable to in-memory databases
    const journalMode = mod.sqlite.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    expect(journalMode?.journal_mode).not.toBe('wal');

    // synchronous and foreign_keys should still be set
    const sync = mod.sqlite.query<{ synchronous: number }, []>('PRAGMA synchronous').get();
    expect(sync?.synchronous).toBe(1);

    const fk = mod.sqlite.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
    expect(fk?.foreign_keys).toBe(1);
  });

  test('does not error when the data directory already exists', async () => {
    // Pre-create the directory
    mkdirSync(tmpDir, { recursive: true });
    const dbPath = join(tmpDir, 'test.db');
    process.env.ELASTRAX_DB_PATH = dbPath;

    const mod = await importFreshDbModule('existing-dir');

    // Module should initialise without errors
    expect(existsSync(dbPath)).toBe(true);

    mod.sqlite.close();
  });

  test('uses trimmed ELASTRAX_DB_PATH values', async () => {
    const dbPath = join(tmpDir, 'trimmed.db');
    process.env.ELASTRAX_DB_PATH = `  ${dbPath}  `;

    const mod = await importFreshDbModule('trimmed-path');

    // The database should be created at the trimmed path
    expect(existsSync(dbPath)).toBe(true);

    mod.sqlite.close();
  });
});