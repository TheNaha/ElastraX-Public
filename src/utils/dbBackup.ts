/**
 * @file src/utils/dbBackup.ts
 * @description Consistent SQLite snapshots via `VACUUM INTO` with keep-N pruning.
 *
 * `VACUUM INTO` produces a compact, fully-checkpointed copy of a live WAL
 * database from a read transaction — safe to run while the bot is serving
 * messages, and the output file is portable (no -wal/-shm siblings needed).
 *
 * Used by scripts/dbBackup.ts (`bun run db:backup`) and safe to call from
 * cron/systemd timers. For continuous off-site replication pair this with the
 * optional Litestream sidecar (see litestream.yml.example).
 */

import { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join, basename } from 'path';
import { logger } from './logger';
import { getErrorMessage } from './errorUtils';

const log = logger.child({ module: 'DbBackup' });

export interface BackupOptions {
  /** Path to the live database file. */
  dbPath: string;
  /** Directory to write timestamped snapshots into (created if missing). */
  backupDir: string;
  /** How many most-recent snapshots to retain. Default 7. */
  keep?: number;
  /** Filename prefix. Default '<dbname>-backup-'. */
  prefix?: string;
}

export interface BackupResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  pruned: string[];
  error?: string;
}

/**
 * Snapshot `dbPath` into `backupDir` using VACUUM INTO, then prune old
 * snapshots beyond `keep`. Never throws — inspect the returned result.
 */
export async function backupDatabase(opts: BackupOptions): Promise<BackupResult> {
  const keep = Math.max(1, opts.keep ?? 7);
  const prefix = opts.prefix ?? `${basename(opts.dbPath)}-backup-`;

  try {
    mkdirSync(opts.backupDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(opts.backupDir, `${prefix}${stamp}.db`);
    // VACUUM INTO refuses to overwrite an existing file.
    rmSync(target, { force: true });

    const live = new Database(opts.dbPath, { readonly: true });
    try {
      live.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      live.close();
    }

    const pruned = pruneOldSnapshots(opts.backupDir, prefix, keep);
    const bytes = statSync(target).size;
    log.info({ target, bytes, pruned: pruned.length }, '[DbBackup] Snapshot created');
    return { ok: true, path: target, bytes, pruned };
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    log.error({ err: message }, '[DbBackup] Backup failed');
    return { ok: false, error: message, pruned: [] };
  }
}

/** Delete the oldest snapshots beyond `keep`; returns removed filenames. */
function pruneOldSnapshots(dir: string, prefix: string, keep: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.db'));
  } catch {
    return [];
  }

  const byNewestFirst = entries
    .map(name => {
      try {
        return { name, mtime: statSync(join(dir, name)).mtimeMs };
      } catch {
        return { name, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime);

  const removed: string[] = [];
  for (const entry of byNewestFirst.slice(keep)) {
    try {
      rmSync(join(dir, entry.name), { force: true });
      removed.push(entry.name);
    } catch (error: unknown) {
      log.warn({ err: getErrorMessage(error), file: entry.name }, '[DbBackup] Failed to prune old snapshot');
    }
  }
  return removed;
}
