import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

import { backupDatabase } from '../src/utils/dbBackup';

const TMP = '/tmp/opencode/dbBackup-test';

function newLiveDb(path: string): Database {
  rmSync(path, { force: true });
  const db = new Database(path);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
  return db;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('backupDatabase', () => {
  test('creates a readable snapshot of a live WAL database', async () => {
    const livePath = join(TMP, 'live.db');
    const db = newLiveDb(livePath);
    db.exec('PRAGMA journal_mode=WAL');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('world');

    const result = await backupDatabase({
      dbPath: livePath,
      backupDir: join(TMP, 'backups'),
      keep: 3,
    });

    db.close();
    expect(result.ok).toBe(true);
    expect(result.path).toBeDefined();
    expect(result.bytes!).toBeGreaterThan(0);

    const copy = new Database(result.path!, { readonly: true });
    const rows = copy.query('SELECT v FROM t ORDER BY id').all() as { v: string }[];
    copy.close();
    expect(rows.map(r => r.v)).toEqual(['hello', 'world']);
    // Snapshot is standalone — no WAL sidecars needed for it.
    const siblings = readdirSync(join(TMP, 'backups')).filter(f => f.endsWith('-wal') || f.endsWith('-shm'));
    expect(siblings).toHaveLength(0);
  });

  test('prunes old snapshots beyond keep', async () => {
    const backupDir = join(TMP, 'backups');
    const livePath = join(TMP, 'source.db');
    const db = newLiveDb(livePath);
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await backupDatabase({ dbPath: livePath, backupDir, keep: 2 });
      if (!r.ok) throw new Error(r.error);
      results.push(r.path!);
      // Ensure distinct mtimes/timestamps between runs.
      await Bun.sleep(1100);
    }
    db.close();
    const files = readdirSync(backupDir).filter(f => f.endsWith('.db')).sort();
    expect(files).toHaveLength(2);
    expect(files).not.toContain(results[0]!.split('/').pop()!);
  });

  test('reports failure instead of throwing on bad source path', async () => {
    const result = await backupDatabase({
      dbPath: join(TMP, 'does-not-exist.db'),
      backupDir: join(TMP, 'backups'),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
