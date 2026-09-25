import * as fsPromises from 'fs/promises';
import { join } from 'node:path';
import { getMediaRetentionHours } from '../../src/config/runtime';
import { getTempMediaDir } from './tempMedia';

function asErrnoException(error: unknown): NodeJS.ErrnoException {
  return error as NodeJS.ErrnoException;
}

export class MediaCleanup {
  static async pruneOldFiles(): Promise<void> {
    const maxAgeHours = getMediaRetentionHours();
    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
    try {
      const names = await fsPromises.readdir(getTempMediaDir());
      for (const name of names) {
        const filePath = join(getTempMediaDir(), name);
        try {
          const info = await fsPromises.stat(filePath);
          if (info.isFile() && info.mtimeMs < cutoff) await fsPromises.unlink(filePath);
        } catch {
          continue;
        }
      }
    } catch (error: unknown) {
      const err = asErrnoException(error);
      if (err.code !== 'ENOENT') return;
    }
  }
}
