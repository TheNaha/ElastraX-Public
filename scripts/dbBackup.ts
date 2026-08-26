/**
 * @file scripts/dbBackup.ts
 * @description CLI wrapper around utils/dbBackup — `bun run db:backup`.
 *
 * Environment overrides:
 *   ELASTRAX_DB_PATH  Live database file (default: <repo>/data/bot.db, same as the app)
 *   BACKUP_DIR        Snapshot directory (default: <repo>/data/backups)
 *   BACKUP_KEEP       Snapshots to retain (default 7)
 *
 * Exit codes: 0 = snapshot written; 1 = backup failed.
 */

import { backupDatabase } from '../src/utils/dbBackup';
import { ROOT_DIR } from '../src/core/constants';
import { join } from 'path';

const dbPath = process.env.ELASTRAX_DB_PATH?.trim() || join(ROOT_DIR, 'data/bot.db');
const backupDir = process.env.BACKUP_DIR?.trim() || join(ROOT_DIR, 'data/backups');
const keepRaw = parseInt(process.env.BACKUP_KEEP ?? '', 10);
const keep = Number.isFinite(keepRaw) && keepRaw > 0 ? keepRaw : 7;

const result = await backupDatabase({ dbPath, backupDir, keep });

if (!result.ok) {
  console.error(`[db:backup] FAILED: ${result.error}`);
  process.exit(1);
}

console.log(`[db:backup] Snapshot: ${result.path} (${((result.bytes ?? 0) / 1024 / 1024).toFixed(2)} MB)`);
if (result.pruned.length > 0) {
  console.log(`[db:backup] Pruned ${result.pruned.length} old snapshot(s): ${result.pruned.join(', ')}`);
}
