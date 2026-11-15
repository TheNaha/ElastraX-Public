import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getTestWorkerPaths } from './helpers/paths';

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
    expect(manifest.database.migrationCount).toBe(25);
    expect(manifest.snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);

    const destination = join(TMP, 'restored-new.db');
    const restored = await restoreDatabase({
      backupPath: result.path!,
      manifestPath: result.manifestPath,
      destination,
      requireCurrentSchema: true,
      expectedSchemaVersion: 25,
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

  /**
   * `snapshot.file` is read back out of a JSON file in the backup directory.
   * Pruning joined it onto the directory without a check, so a planted manifest
   * naming `../victim.db` made the sweep delete a file outside the directory.
   */
  test('refuses to prune a snapshot whose manifest names a path outside the backup directory', async () => {
    const backupDir = join(TMP, 'traversal-backups');
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const victimPath = join(TMP, 'victim.db');
    writeFileSync(victimPath, 'keep me');

    writeFileSync(
      join(backupDir, 'planted.db.manifest.json'),
      JSON.stringify({
        formatVersion: 1,
        createdAt: new Date(Date.now() - 86_400_000).toISOString(),
        sourceName: 'bot.db',
        snapshot: { file: '../victim.db', bytes: 7, sha256: 'a'.repeat(64) },
        database: { integrityCheck: 'ok', foreignKeyViolations: 0, schemaFingerprint: 'x', migrationCount: 0, latestMigration: null, schemaVersion: null, userVersion: 0 },
      }),
      { mode: 0o600 },
    );

    const sourcePath = join(TMP, 'traversal-source.db');
    const source = newLiveDb(sourcePath);
    source.close();
    const result = await backupDatabase({ dbPath: sourcePath, backupDir, keep: 1 });
    expect(result.ok).toBe(true);

    expect(readFileSync(victimPath, 'utf8')).toBe('keep me');
    expect(result.pruned.some(path => path.endsWith('victim.db'))).toBe(false);
  });

  /**
   * A snapshot is published just before its manifest, so a crash in between
   * leaves a `.db` nothing points at. The sweep removes it once it is older than
   * the grace window and leaves a fresh one (it may be mid-publication) alone.
   */
  test('sweeps orphaned snapshots but keeps a freshly written one', async () => {
    const backupDir = join(TMP, 'orphan-backups');
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const orphanPath = join(backupDir, 'orphan.db');
    const freshPath = join(backupDir, 'fresh.db');
    writeFileSync(orphanPath, 'orphan');
    writeFileSync(freshPath, 'fresh');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(orphanPath, old, old);

    const sourcePath = join(TMP, 'orphan-source.db');
    const source = newLiveDb(sourcePath);
    source.close();
    const result = await backupDatabase({ dbPath: sourcePath, backupDir, keep: 5 });
    expect(result.ok).toBe(true);

    expect(() => statSync(orphanPath)).toThrow();
    expect(statSync(freshPath).size).toBe('fresh'.length);
  });

  test('rejects a tampered backup without publishing the restore destination', async () => {    const sourcePath = join(TMP, 'tamper-source.db');
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
