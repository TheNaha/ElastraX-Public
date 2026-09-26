import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getTestWorkerPaths } from './helpers/paths';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

import { backupDatabase, restoreDatabase } from '../src/db/backup';
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

    const result = await backupDatabase({
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
    expect(manifest.database.migrationCount).toBe(23);
    expect(manifest.snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);

    const destination = join(TMP, 'restored-new.db');
    const restored = await restoreDatabase({
      backupPath: result.path!,
      manifestPath: result.manifestPath,
      destination,
      requireCurrentSchema: true,
      expectedSchemaVersion: 23,
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
    const result = await backupDatabase({ dbPath: sourcePath, backupDir: join(TMP, 'tamper-backups') });
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
