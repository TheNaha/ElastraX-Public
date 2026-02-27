import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { MediaCleanup } from '../src/utils/MediaCleanup';
import * as fsPromises from 'fs/promises';

describe('MediaCleanup', () => {
  let readdirSpy: ReturnType<typeof spyOn>;
  let statSpy: ReturnType<typeof spyOn>;
  let unlinkSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    unlinkSpy = spyOn(fsPromises, 'unlink').mockResolvedValue(undefined);
    readdirSpy = spyOn(fsPromises, 'readdir').mockResolvedValue(['old.jpg', 'new.jpg'] as any);
    statSpy = spyOn(fsPromises, 'stat').mockImplementation(async (path: any) => {
      const isOld = String(path).includes('old');
      return {
        isFile: () => true,
        mtimeMs: isOld ? Date.now() - 100 * 60 * 60 * 1000 : Date.now(),
      } as any;
    });
  });

  afterEach(() => {
    readdirSpy.mockRestore();
    statSpy.mockRestore();
    unlinkSpy.mockRestore();
  });

  test('pruneOldFiles deletes files older than cutoff', async () => {
    await MediaCleanup.pruneOldFiles();
    // old.jpg should be deleted (100 hours old > 72 hour default)
    expect(unlinkSpy).toHaveBeenCalled();
  });

  test('pruneOldFiles does not delete recent files', async () => {
    readdirSpy.mockResolvedValue(['recent.jpg'] as any);
    statSpy.mockResolvedValue({
      isFile: () => true,
      mtimeMs: Date.now(),
    } as any);

    await MediaCleanup.pruneOldFiles();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  test('handles ENOENT gracefully', async () => {
    const err = new Error('ENOENT') as any;
    err.code = 'ENOENT';
    readdirSpy.mockRejectedValue(err);

    // Should not throw
    await MediaCleanup.pruneOldFiles();
  });
});
