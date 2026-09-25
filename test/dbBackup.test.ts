import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getTestWorkerPaths } from './helpers/paths';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

import { backupDatabase } from '../src/utils/dbBackup';
import { backupDatabase as backupWithManifest, restoreDatabase } from '../src/db/backup';
import { createDatabase, ensureDatabaseSchema } from '../src/db';

// Each run gets its own directory inside the worker sandbox; a shared global
// temp path makes this suite order-dependent when files run in parallel.
const WORKER_ROOT = getTestWorkerPaths().root;
let TMP = '';

function newLiveDb(path: string): Database {
  rmSync(path, { force: true });
  const db = new Database(path);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
  return db;
}

beforeEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  TMP = join(WORKER_ROOT, 'dbbackup', randomUUID());
  mkdirSync(TMP, { recursive: true, mode: 0o700 });
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
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

  test('writes a restrictive checksum manifest and restores only to a validated new file', async () => {
    const sourcePath = join(TMP, 'manifest-source.db');
    const handle = createDatabase({ path: sourcePath });
    try {
      await ensureDatabaseSchema({ database: handle, leaseName: null });
      handle.sqlite.exec(`
        INSERT INTO chat_rooms (id, platform, created_at) VALUES ('backup-room', 'whatsapp', 1000);
        INSERT INTO app_kv (id, value, updated_at) VALUES ('backup-key', 'backup-value', 1000);
      `);
    } finally {
      handle.close();
    }

    const result = await backupWithManifest({
      dbPath: sourcePath,
      backupDir: join(TMP, 'manifest-backups'),
      keep: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.manifestPath).toBeDefined();
    expect(statSync(result.path!).mode & 0o777).toBe(0o600);
    expect(statSync(result.manifestPath!).mode & 0o777).toBe(0o600);

    const manifest = JSON.parse(readFileSync(result.manifestPath!, 'utf8'));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.database.migrationCount).toBe(22);
    expect(manifest.snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);

    const destination = join(TMP, 'restored-new.db');
    const restored = await restoreDatabase({
      backupPath: result.path!,
      manifestPath: result.manifestPath,
      destination,
      requireCurrentSchema: true,
      expectedSchemaVersion: 22,
    });
    expect(restored.ok).toBe(true);
    expect(readdirSync(TMP).some(name => name.includes('.tmp'))).toBe(false);

    const restoredDb = new Database(destination, { readonly: true });
    expect(restoredDb.query<{ value: string }, [string]>('SELECT value FROM app_kv WHERE id = ?').get('backup-key')?.value).toBe('backup-value');
    restoredDb.close();

    const overwrite = await restoreDatabase({
      backupPath: result.path!,
      manifestPath: result.manifestPath,
      destination,
    });
    expect(overwrite.ok).toBe(false);
    expect(overwrite.error).toContain('new file');
  });

  test('rejects a tampered backup without publishing the restore destination', async () => {
    const sourcePath = join(TMP, 'tamper-source.db');
    const source = newLiveDb(sourcePath);
    source.close();
    const result = await backupWithManifest({ dbPath: sourcePath, backupDir: join(TMP, 'tamper-backups') });
    if (!result.ok) throw new Error(result.error);

    const manifestPath = result.manifestPath!;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.snapshot.sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    chmodSync(manifestPath, 0o600);

    const destination = join(TMP, 'must-not-exist.db');
    const restored = await restoreDatabase({
      backupPath: result.path!,
      manifestPath,
      destination,
    });
    expect(restored.ok).toBe(false);
    expect(restored.error).toContain('SHA-256');
    expect(() => statSync(destination)).toThrow();
  });
});
