import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { MediaCleanup, mediaCleanupDeps } from '../src/utils/MediaCleanup';
import { mediaStorageDeps } from '../src/utils/MediaStorage';

const original = {
  cleanupStat: mediaCleanupDeps.stat,
  cleanupUnlink: mediaCleanupDeps.unlink,
  storageReaddir: mediaStorageDeps.readdir,
  storageStat: mediaStorageDeps.stat,
  storageUnlink: mediaStorageDeps.unlink,
};
const mocks = {
  readdir: mock(async () => ['old.jpg', 'new.jpg'] as string[]),
  stat: mock(async (file: string) => ({
    isFile: () => true,
    size: 10,
    mtimeMs: file.endsWith('old.jpg') ? 1 : Date.now(),
  })),
  unlink: mock(async (_file: string) => {}),
};

describe('MediaCleanup', () => {
  const originalRetentionHours = process.env.MEDIA_RETENTION_HOURS;

  beforeEach(() => {
    for (const value of Object.values(mocks)) value.mockClear();
    mocks.readdir.mockImplementation(async () => ['old.jpg', 'new.jpg']);
    mocks.stat.mockImplementation(async file => ({
      isFile: () => true,
      size: 10,
      mtimeMs: file.endsWith('old.jpg') ? 1 : Date.now(),
    }) as never);
    mediaStorageDeps.readdir = mocks.readdir as never;
    mediaStorageDeps.stat = mocks.stat as never;
    mediaStorageDeps.unlink = mocks.unlink as never;
    mediaCleanupDeps.stat = mocks.stat as never;
    mediaCleanupDeps.unlink = mocks.unlink as never;
  });

  afterEach(() => {
    mediaCleanupDeps.stat = original.cleanupStat;
    mediaCleanupDeps.unlink = original.cleanupUnlink;
    mediaStorageDeps.readdir = original.storageReaddir;
    mediaStorageDeps.stat = original.storageStat;
    mediaStorageDeps.unlink = original.storageUnlink;
    if (originalRetentionHours === undefined) delete process.env.MEDIA_RETENTION_HOURS;
    else process.env.MEDIA_RETENTION_HOURS = originalRetentionHours;
  });

  test('pruneOldFiles deletes files older than cutoff', async () => {
    await MediaCleanup.pruneOldFiles({ clearReferences: false });
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    expect(mocks.unlink.mock.calls[0]?.[0]).toContain('old.jpg');
  });

  test('pruneOldFiles does not delete recent files', async () => {
    mocks.readdir.mockImplementation(async () => ['recent.jpg']);
    mocks.stat.mockImplementation(async () => ({ isFile: () => true, size: 10, mtimeMs: Date.now() }) as never);
    await MediaCleanup.pruneOldFiles({ clearReferences: false });
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  test('handles ENOENT gracefully', async () => {
    mocks.readdir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(MediaCleanup.pruneOldFiles({ clearReferences: false })).resolves.toBeUndefined();
  });

  test('invalid retention falls back to the default window', async () => {
    process.env.MEDIA_RETENTION_HOURS = 'invalid';
    await MediaCleanup.pruneOldFiles({ clearReferences: false });
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
  });
});
