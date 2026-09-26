import { existsSync } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { messages } from '../db/schema';
import { getMediaRetentionHours } from '../config/runtime';
import { logger } from './logger';
import { MEDIA_DIR, mediaStorageDeps, reconcileMediaQuota } from './MediaStorage';

export interface PruneMediaOptions {
  now?: number;
  clearReferences?: boolean;
}

export const mediaCleanupDeps = {
  stat,
  unlink,
  existsSync,
};

export class MediaCleanup {
  static async pruneOldFiles(options: PruneMediaOptions = {}): Promise<void> {
    const maxAgeHours = getMediaRetentionHours();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const cutoff = (options.now ?? Date.now()) - maxAgeMs;
    const deleted: string[] = [];

    try {
      const names = await mediaStorageDeps.readdir(MEDIA_DIR);
      for (const name of names) {
        const filePath = join(MEDIA_DIR, name);
        try {
          const info = await mediaCleanupDeps.stat(filePath);
          if (!info.isFile()) continue;
          if (info.mtimeMs < cutoff) {
            await mediaCleanupDeps.unlink(filePath);
            deleted.push(filePath);
          }
        } catch {
          continue;
        }
      }
      const quota = await reconcileMediaQuota(0, undefined, 0);
      deleted.push(...quota.deleted.filter(path => !deleted.includes(path)));
      if (options.clearReferences !== false) {
        // Always pass the pruned list. Passing `undefined` sent
        // clearStaleMediaReferences down its full-scan branch, which selected
        // every message row with a media path and issued a blocking
        // `existsSync` per row — cost scaling with total history, on a job that
        // runs at startup and every few hours even when nothing aged out.
        await MediaCleanup.clearStaleMediaReferences(deleted);
      }
      if (deleted.length > 0) {
        logger.info({ deleted: deleted.length, maxAgeHours }, '[MediaCleanup] Pruned media files');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err: error }, '[MediaCleanup] Failed to prune media directory');
      }
    }
  }

  static async clearStaleMediaReferences(paths?: string[]): Promise<number> {
    try {
      let stalePaths = paths?.map(path => path.trim()).filter(Boolean) ?? [];
      if (!paths) {
        const rows = await db
          .select({ mediaPath: messages.mediaPath })
          .from(messages)
          .where(isNotNull(messages.mediaPath));
        stalePaths = rows
          .map(row => row.mediaPath)
          .filter((path): path is string => !!path && !mediaCleanupDeps.existsSync(path));
      }
      if (stalePaths.length === 0) return 0;
      const uniquePaths = [...new Set(stalePaths)];
      for (let index = 0; index < uniquePaths.length; index += 400) {
        const batch = uniquePaths.slice(index, index + 400);
        await db
          .update(messages)
          .set({ mediaPath: null, mimeType: null })
          .where(inArray(messages.mediaPath, batch));
      }
      return uniquePaths.length;
    } catch (error) {
      logger.warn({ err: error }, '[MediaCleanup] Failed to clear stale media references');
      return 0;
    }
  }
}
