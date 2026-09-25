import { Database } from 'bun:sqlite';
import { dirname, isAbsolute, resolve } from 'node:path';
import { resolveDatabasePath } from '../src/config/database';
import { backupDatabase, restoreDatabase } from '../src/db/backup';
import { createDatabase, ensureDatabaseSchema } from '../src/db';
import {
  fingerprintSchema,
  getMigrationsFolder,
  inspectMigrationState,
  readMigrationJournal,
  validateSchemaContract,
  verifyStoredSchemaFingerprint,
} from '../src/db/migrations';

function integerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export async function runBackup(): Promise<number> {
  const databasePath = resolveDatabasePath();
  const configuredBackupDir = process.env.BACKUP_DIR?.trim();
  const backupDir = configuredBackupDir
    ? isAbsolute(configuredBackupDir) ? configuredBackupDir : resolve(configuredBackupDir)
    : resolve(dirname(databasePath), 'backups');
  const result = await backupDatabase({
    dbPath: databasePath,
    backupDir,
    keep: integerEnv('BACKUP_KEEP', 7),
  });
  if (!result.ok) {
    console.error(`[db:backup] FAILED: ${result.error}`);
    return 1;
  }
  console.log(`[db:backup] Snapshot: ${result.path}`);
  console.log(`[db:backup] Manifest: ${result.manifestPath}`);
  console.log(`[db:backup] Bytes: ${result.bytes}`);
  if (result.pruned.length > 0) console.log(`[db:backup] Pruned: ${result.pruned.length}`);
  return 0;
}

export async function runMigrate(): Promise<number> {
  const handle = createDatabase({ path: resolveDatabasePath() });
  try {
    await ensureDatabaseSchema({ database: handle });
    console.log(`[db:migrate] Schema ensured: ${handle.path}`);
    return 0;
  } catch (error) {
    console.error(`[db:migrate] FAILED: ${error instanceof Error ? error.message : error}`);
    return 1;
  } finally {
    handle.close();
  }
}

export async function runPreflight(): Promise<number> {
  const databasePath = resolveDatabasePath();
  const migrationsFolder = getMigrationsFolder();
  const sqlite = new Database(databasePath, { readonly: true, strict: true });
  try {
    const state = inspectMigrationState(sqlite, migrationsFolder);
    const storedFingerprint = verifyStoredSchemaFingerprint(sqlite);
    const fingerprint = storedFingerprint ?? fingerprintSchema(sqlite);
    validateSchemaContract(sqlite);
    const latest = readMigrationJournal(migrationsFolder).at(-1)?.tag ?? null;
    console.log(`[db:preflight] Path: ${databasePath}`);
    console.log(`[db:preflight] Applied: ${state.applied.length}`);
    console.log(`[db:preflight] Pending: ${state.pending.length}`);
    console.log(`[db:preflight] Latest: ${latest}`);
    console.log(`[db:preflight] Fingerprint: ${fingerprint}`);
    return 0;
  } finally {
    sqlite.close();
  }
}

export async function runRestore(): Promise<number> {
  const backupPath = process.env.DB_BACKUP_PATH?.trim();
  const destination = process.env.DB_RESTORE_PATH?.trim();
  if (!backupPath || !destination) {
    console.error('[db:restore] DB_BACKUP_PATH and DB_RESTORE_PATH are required');
    return 2;
  }
  if (resolve(backupPath) === resolve(destination)) {
    console.error('[db:restore] Destination must be a different, new file');
    return 2;
  }
  const migrationsFolder = getMigrationsFolder();
  const expectedSchemaVersion = readMigrationJournal(migrationsFolder).at(-1)?.when;
  const result = await restoreDatabase({
    backupPath: resolve(backupPath),
    destination: resolve(destination),
    requireCurrentSchema: true,
    expectedSchemaVersion,
    migrationsFolder,
  });
  if (!result.ok) {
    console.error(`[db:restore] FAILED: ${result.error}`);
    return 1;
  }
  console.log(`[db:restore] Validated new database: ${result.path}`);
  return 0;
}

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'backup';
  let exitCode: number;
  if (action === 'backup') exitCode = await runBackup();
  else if (action === 'migrate') exitCode = await runMigrate();
  else if (action === 'preflight') exitCode = await runPreflight();
  else if (action === 'restore') exitCode = await runRestore();
  else {
    console.error(`[db] Unknown action: ${action}`);
    exitCode = 2;
  }
  process.exitCode = exitCode;
}

if (import.meta.main) await main();
