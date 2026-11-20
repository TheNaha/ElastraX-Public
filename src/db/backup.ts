import { Database } from 'bun:sqlite';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { safeErrorMessage } from '../utils/errorUtils.js';
import { nowISO } from '../utils/date.js';
import { logger } from '../utils/logger.js';
import {
  fingerprintSchema,
  getMigrationsFolder,
  readMigrationJournal,
  validateSchemaContract,
  verifyStoredSchemaFingerprint,
  type MigrationJournalEntry,
} from './migrations.js';

export interface BackupOptions {
  dbPath: string;
  backupDir: string;
  keep?: number;
  prefix?: string;
  /** Journal folder used to name the latest applied migration. Defaults to the shipped migrations. */
  migrationsFolder?: string;
}

export interface BackupManifest {
  formatVersion: 1;
  createdAt: string;
  sourceName: string;
  snapshot: {
    file: string;
    bytes: number;
    sha256: string;
  };
  database: {
    integrityCheck: string;
    foreignKeyViolations: number;
    schemaFingerprint: string;
    migrationCount: number;
    latestMigration: string | null;
    schemaVersion: number | null;
    userVersion: number;
  };
}

export interface BackupResult {
  ok: boolean;
  path?: string;
  manifestPath?: string;
  bytes?: number;
  pruned: string[];
  error?: string;
}

export interface RestoreOptions {
  backupPath: string;
  destination: string;
  manifestPath?: string;
  requireCurrentSchema?: boolean;
  /**
   * Highest schema version the snapshot may carry, i.e. the current journal's
   * latest `when`.
   *
   * An older version is accepted on purpose: refusing anything but the newest
   * made every backup unrestorable from the moment a new migration shipped,
   * which is exactly the "I upgraded and it broke, roll back" case restore
   * exists for. The caller is expected to migrate the restored copy forward
   * (`ensureDatabaseSchema`) before using it.
   */
  maxSchemaVersion?: number;
  migrationsFolder?: string;
}

export interface RestoreResult {
  ok: boolean;
  path?: string;
  manifest?: BackupManifest;
  error?: string;
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function ensureDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
}

function temporarySibling(path: string, suffix: string): string {
  return join(dirname(path), `.${basename(path)}.${randomUUID()}${suffix}`);
}

/**
 * How long an unreferenced snapshot must sit in the backup directory before the
 * orphan sweep deletes it. A snapshot is published a moment before its manifest,
 * so a sweep running in that window must not treat it as garbage.
 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** Remove `path`; returns whether it is gone. Never throws. */
function removeFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function publishAtomically(temporaryPath: string, destination: string): void {
  linkSync(temporaryPath, destination);
  removeFile(temporaryPath);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function migrationSummary(sqlite: Database, migrationsFolder?: string): {
  count: number;
  latest: string | null;
} {
  const hasLedger = sqlite
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (!hasLedger) return { count: 0, latest: null };
  const row = sqlite
    .query<{ count: number }, []>('SELECT count(*) AS count FROM __drizzle_migrations')
    .get();
  const count = Number(row?.count ?? 0);
  if (!migrationsFolder || count === 0) return { count, latest: null };
  const entries: MigrationJournalEntry[] = readMigrationJournal(migrationsFolder);
  return { count, latest: entries[count - 1]?.tag ?? null };
}

function validateDatabaseFile(
  path: string,
  expected?: Pick<BackupManifest, 'snapshot' | 'database'>,
  options: { migrationsFolder?: string; requireCurrentSchema?: boolean; maxSchemaVersion?: number } = {},
): BackupManifest['database'] {
  const sqlite = new Database(path, { readonly: true, strict: true });
  try {
    const integrityRows = sqlite.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all();
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') {
      throw new Error('SQLite integrity_check failed');
    }
    const foreignKeyViolations = Number(
      sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM pragma_foreign_key_check').get()?.count ?? 0,
    );
    if (foreignKeyViolations !== 0) throw new Error('SQLite foreign_key_check failed');
    const schemaFingerprint = fingerprintSchema(sqlite);
    verifyStoredSchemaFingerprint(sqlite);
    const migrations = migrationSummary(sqlite, options.migrationsFolder);
    const hasSchemaMeta = sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'db_schema_meta'")
      .get();
    const meta = hasSchemaMeta
      ? sqlite.query<{ schema_version: number }, []>('SELECT schema_version FROM db_schema_meta WHERE id = 1').get()
      : undefined;
    const userVersion = Number(sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0);

    if (expected) {
      const bytes = statSync(path).size;
      if (bytes !== expected.snapshot.bytes) throw new Error('Backup size does not match its manifest');
      if (schemaFingerprint !== expected.database.schemaFingerprint) {
        throw new Error('Backup schema fingerprint does not match its manifest');
      }
      if (migrations.count !== expected.database.migrationCount) {
        throw new Error('Backup migration count does not match its manifest');
      }
    }

    if (options.requireCurrentSchema) {
      if (!meta) throw new Error('Current-schema backup is missing db_schema_meta');
      validateSchemaContract(sqlite);
    }
    if (options.maxSchemaVersion !== undefined) {
      // Only a *future* schema is refused. An older one is the normal rollback
      // case and is migrated forward by the caller. A `schema_version` from
      // before the journal's `when` was renumbered to 1..N is an epoch-ms value
      // (≈1.7e12); it predates every current `when` by definition and must not be
      // mistaken for a future schema.
      if (!meta) throw new Error('Backup is missing db_schema_meta');
      const version = Number(meta.schema_version);
      const legacyTimestamp = Number.isFinite(version) && version >= 1_000_000_000_000;
      if (!Number.isFinite(version) || (!legacyTimestamp && version > options.maxSchemaVersion)) {
        throw new Error(
          `Backup schema version ${version} is newer than this build (${options.maxSchemaVersion})`,
        );
      }
    }
    return {
      integrityCheck: 'ok',
      foreignKeyViolations,
      schemaFingerprint,
      migrationCount: migrations.count,
      latestMigration: migrations.latest,
      schemaVersion: meta ? Number(meta.schema_version) : null,
      userVersion,
    };
  } finally {
    sqlite.close();
  }
}

function parseManifest(path: string): BackupManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as BackupManifest;
    if (
      manifest.formatVersion !== 1
      || typeof manifest.snapshot?.file !== 'string'
      || !/^[a-f0-9]{64}$/.test(manifest.snapshot?.sha256 ?? '')
      || !Number.isSafeInteger(manifest.snapshot?.bytes)
      // `pruneBackups` sorts by this; an unparseable value made the comparator
      // return NaN, which left the order implementation-defined and could pick
      // a valid recent backup for deletion while keeping the broken one.
      || !Number.isFinite(Date.parse(manifest.createdAt))
      // `validateDatabaseFile` dereferences `database.schemaFingerprint` as soon
      // as a manifest is supplied, so a manifest without the object surfaced a
      // `TypeError` ("cannot read properties of undefined") instead of the
      // honest "manifest is invalid".
      || typeof manifest.database !== 'object'
      || manifest.database === null
      || typeof manifest.database.schemaFingerprint !== 'string'
      || !Number.isSafeInteger(manifest.database.migrationCount)
    ) return null;
    return manifest;
  } catch {
    return null;
  }
}

function pruneBackups(backupDir: string, keep: number, currentManifestPath: string): string[] {
  const entries = readdirSync(backupDir)
    .filter(name => name.endsWith('.db.manifest.json'))
    .map(name => {
      const manifestPath = join(backupDir, name);
      const manifest = parseManifest(manifestPath);
      return manifest ? { manifestPath, createdAt: Date.parse(manifest.createdAt) } : null;
    })
    .filter((entry): entry is { manifestPath: string; createdAt: number } => entry !== null)
    .sort((a, b) => b.createdAt - a.createdAt);

  const removed: string[] = [];
  for (const entry of entries.slice(Math.max(1, keep))) {
    if (entry.manifestPath === currentManifestPath) continue;
    const manifest = parseManifest(entry.manifestPath);
    if (!manifest) continue;
    // `snapshot.file` comes out of a JSON file on disk, so it must be a bare
    // filename: `join(backupDir, '../../x')` would otherwise let a planted
    // manifest delete a file outside the backup directory.
    if (basename(manifest.snapshot.file) !== manifest.snapshot.file) {
      logger.warn({ manifestPath: entry.manifestPath, file: manifest.snapshot.file }, '[backup] Manifest names a file outside the backup directory; refusing to prune it');
      continue;
    }
    const databasePath = join(backupDir, manifest.snapshot.file);
    try {
      // Only report a snapshot as pruned when both files are actually gone: a
      // read-only or full backup volume made `unlink` fail silently, and the
      // caller printed "Pruned: N" for space that was never reclaimed (and left
      // the manifest deleted under a snapshot the next sweep must handle).
      const removedDatabase = removeFile(databasePath);
      const removedManifest = removeFile(entry.manifestPath);
      if (removedDatabase && removedManifest) removed.push(databasePath);
      else logger.warn({ manifestPath: entry.manifestPath, databasePath }, '[backup] Snapshot files could not be pruned');
    } catch (error) {
      logger.warn({ err: error, manifestPath: entry.manifestPath }, '[backup] Prune failed');
    }
  }

  // Snapshots are published just before their manifest, so a crash in between
  // leaves a `.db` that no manifest points at and nothing ever deletes. Sweep
  // the orphans that are older than the current run (the one being written is
  // still a temporary sibling, not a `*.db` in the directory).
  //
  // If any manifest cannot be read (bit rot, a future formatVersion, a hand
  // edit) its snapshot is indistinguishable from an orphan, so the sweep is
  // skipped rather than deleting a real backup.
  const live = new Set<string>();
  let unreadableManifest = false;
  for (const name of readdirSync(backupDir)) {
    if (!name.endsWith('.db.manifest.json')) continue;
    const manifest = parseManifest(join(backupDir, name));
    if (manifest) live.add(manifest.snapshot.file);
    else unreadableManifest = true;
  }
  if (unreadableManifest) {
    logger.warn({ backupDir }, '[backup] Skipping the orphan sweep: at least one manifest could not be parsed');
  } else {
    for (const name of readdirSync(backupDir)) {
      if (!name.endsWith('.db') || name.startsWith('.')) continue;
      if (live.has(name)) continue;
      const path = join(backupDir, name);
      try {
        if (Date.now() - statSync(path).mtimeMs < ORPHAN_GRACE_MS) continue;
        if (removeFile(path)) removed.push(path);
        else logger.warn({ path }, '[backup] Orphan snapshot could not be removed');
      } catch (error) {
        logger.warn({ err: error, path }, '[backup] Orphan sweep skipped a file');
      }
    }
  }
  return removed;
}

export async function backupDatabase(options: BackupOptions): Promise<BackupResult> {
  const keep = Math.max(1, Math.trunc(options.keep ?? 7));
  const prefix = options.prefix ?? `${basename(options.dbPath)}-backup-`;
  let temporaryDatabase: string | null = null;
  let temporaryManifest: string | null = null;

  try {
    if (!existsSync(options.dbPath)) throw new Error(`Database does not exist: ${options.dbPath}`);
    ensureDirectory(options.backupDir);
    const stamp = nowISO().replace(/[:.]/g, '-');
    const name = `${prefix}${stamp}-${randomUUID()}.db`;
    const target = join(options.backupDir, name);
    const manifestTarget = `${target}.manifest.json`;
    temporaryDatabase = temporarySibling(target, '.tmp');
    temporaryManifest = temporarySibling(manifestTarget, '.tmp');

    const source = new Database(options.dbPath, { readonly: true, strict: true });
    try {
      source.exec(`VACUUM INTO ${quoteSqlString(temporaryDatabase)}`);
    } finally {
      source.close();
    }
    chmodSync(temporaryDatabase, 0o600);

    // The migrations folder was never passed here, so `migrationSummary` could
    // not name the latest journal entry and every published manifest recorded
    // `latestMigration: null` — a field no restore check could then use.
    const database = validateDatabaseFile(temporaryDatabase, undefined, {
      migrationsFolder: options.migrationsFolder ?? getMigrationsFolder(),
    });
    const manifest: BackupManifest = {
      formatVersion: 1,
      createdAt: nowISO(),
      sourceName: basename(options.dbPath),
      snapshot: {
        file: name,
        bytes: statSync(temporaryDatabase).size,
        sha256: await sha256File(temporaryDatabase),
      },
      database,
    };
    writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });

    publishAtomically(temporaryDatabase, target);
    temporaryDatabase = null;
    publishAtomically(temporaryManifest, manifestTarget);
    temporaryManifest = null;
    const pruned = pruneBackups(options.backupDir, keep, manifestTarget);
    return {
      ok: true,
      path: target,
      manifestPath: manifestTarget,
      bytes: manifest.snapshot.bytes,
      pruned,
    };
  } catch (error) {
    if (temporaryDatabase) removeFile(temporaryDatabase);
    if (temporaryManifest) removeFile(temporaryManifest);
    return { ok: false, pruned: [], error: safeErrorMessage(error) };
  }
}

export async function restoreDatabase(options: RestoreOptions): Promise<RestoreResult> {
  const manifestPath = options.manifestPath ?? `${options.backupPath}.manifest.json`;
  let temporaryPath: string | null = null;
  try {
    if (existsSync(options.destination)) throw new Error('Restore destination must be a new file');
    // SQLite treats `<db>-wal` / `<db>-shm` as part of the database. A WAL left
    // beside a deleted database file carries no marker tying it to the *old*
    // file, so the first open of the restored copy would replay those frames
    // into it. Refuse rather than delete: the sibling may belong to a database
    // the operator still cares about.
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${options.destination}${suffix}`)) {
        throw new Error(`Restore destination has a leftover ${suffix} file; remove it first`);
      }
    }
    const manifest = parseManifest(manifestPath);
    if (!manifest) throw new Error('Backup manifest is missing or invalid');
    if (!existsSync(options.backupPath)) throw new Error('Backup database does not exist');
    if (basename(options.backupPath) !== manifest.snapshot.file) {
      throw new Error('Backup filename does not match its manifest');
    }

    ensureDirectory(dirname(options.destination));
    temporaryPath = temporarySibling(options.destination, '.tmp');
    copyFileSync(options.backupPath, temporaryPath, 1);
    chmodSync(temporaryPath, 0o600);
    const actualHash = await sha256File(temporaryPath);
    if (actualHash !== manifest.snapshot.sha256) throw new Error('Backup SHA-256 does not match its manifest');

    const database = validateDatabaseFile(temporaryPath, manifest, {
      migrationsFolder: options.migrationsFolder,
      requireCurrentSchema: options.requireCurrentSchema ?? false,
      maxSchemaVersion: options.maxSchemaVersion,
    });
    if (database.schemaFingerprint !== manifest.database.schemaFingerprint) {
      throw new Error('Restored schema fingerprint does not match its manifest');
    }

    publishAtomically(temporaryPath, options.destination);
    temporaryPath = null;
    return { ok: true, path: options.destination, manifest };
  } catch (error) {
    if (temporaryPath) removeFile(temporaryPath);
    return { ok: false, error: safeErrorMessage(error) };
  }
}
