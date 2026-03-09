import { readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { logger } from './logger';

const MEDIA_DIR = './data/media';

function asErrnoException(error: unknown): NodeJS.ErrnoException {
  return error as NodeJS.ErrnoException;
}

export class MediaCleanup {
  static async pruneOldFiles(): Promise<void> {
    const maxAgeHours = parseInt(process.env.MEDIA_RETENTION_HOURS || '72', 10);
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAgeMs;

    try {
      const names = await readdir(MEDIA_DIR);
      let deleted = 0;

      for (const name of names) {
        const filePath = join(MEDIA_DIR, name);
        try {
          const info = await stat(filePath);
          if (!info.isFile()) continue;
          if (info.mtimeMs < cutoff) {
            await unlink(filePath);
            deleted++;
          }
        } catch {
          continue;
        }
      }

      if (deleted > 0) {
        logger.info({ deleted, maxAgeHours }, '[MediaCleanup] Pruned old media files');
      }
    } catch (error: unknown) {
      const err = asErrnoException(error);
      if (err.code !== 'ENOENT') {
        logger.warn({ err: error }, '[MediaCleanup] Failed to prune media directory');
      }
    }
  }
}
