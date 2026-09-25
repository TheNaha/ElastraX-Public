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
import {
  fingerprintSchema,
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
  expectedSchemaVersion?: number;
  migrationsFolder?: string;
}

export interface RestoreResult {
  ok: boolean;
  path?: string;
  manifest?: BackupManifest;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    void error;
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
  options: { migrationsFolder?: string; requireCurrentSchema?: boolean; expectedSchemaVersion?: number } = {},
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
    if (options.expectedSchemaVersion !== undefined && (!meta || Number(meta.schema_version) !== options.expectedSchemaVersion)) {
      throw new Error('Backup schema version is not the requested version');
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
    const databasePath = join(backupDir, manifest.snapshot.file);
    try {
      removeFile(databasePath);
      unlinkSync(entry.manifestPath);
      removed.push(databasePath);
    } catch (error) {
      void error;
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
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
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

    const database = validateDatabaseFile(temporaryDatabase);
    const manifest: BackupManifest = {
      formatVersion: 1,
      createdAt: new Date().toISOString(),
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
    return { ok: false, pruned: [], error: errorMessage(error) };
  }
}

export async function restoreDatabase(options: RestoreOptions): Promise<RestoreResult> {
  const manifestPath = options.manifestPath ?? `${options.backupPath}.manifest.json`;
  let temporaryPath: string | null = null;
  try {
    if (existsSync(options.destination)) throw new Error('Restore destination must be a new file');
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
      expectedSchemaVersion: options.expectedSchemaVersion,
    });
    if (database.schemaFingerprint !== manifest.database.schemaFingerprint) {
      throw new Error('Restored schema fingerprint does not match its manifest');
    }

    publishAtomically(temporaryPath, options.destination);
    temporaryPath = null;
    return { ok: true, path: options.destination, manifest };
  } catch (error) {
    if (temporaryPath) removeFile(temporaryPath);
    return { ok: false, error: errorMessage(error) };
  }
}
