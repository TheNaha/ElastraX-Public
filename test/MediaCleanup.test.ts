import { describe, test, expect, mock } from 'bun:test';

const mockUnlink = mock(async () => {});
const mockStat = mock(async (path: string) => {
  const isOld = path.includes('old');
  return {
    isFile: () => true,
    mtimeMs: isOld ? Date.now() - 100 * 60 * 60 * 1000 : Date.now(),
  };
});
const mockReaddir = mock(async () => ['old.jpg', 'new.jpg']);

mock.module('fs/promises', () => ({
  readdir: mockReaddir,
  stat: mockStat,
  unlink: mockUnlink,
}));
mock.module('../src/utils/logger', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) },
}));

import { MediaCleanup } from '../src/utils/MediaCleanup';

describe('MediaCleanup', () => {
  test('pruneOldFiles deletes files older than cutoff', async () => {
    mockUnlink.mockClear();
    mockReaddir.mockImplementation(async () => ['old.jpg', 'new.jpg']);
    mockStat.mockImplementation(async (path: string) => {
      const isOld = path.includes('old');
      return {
        isFile: () => true,
        mtimeMs: isOld ? Date.now() - 100 * 60 * 60 * 1000 : Date.now(),
      };
    });

    await MediaCleanup.pruneOldFiles();
    // old.jpg should be deleted (100 hours old > 72 hour default)
    expect(mockUnlink).toHaveBeenCalled();
  });

  test('pruneOldFiles does not delete recent files', async () => {
    mockUnlink.mockClear();
    mockReaddir.mockImplementation(async () => ['recent.jpg']);
    mockStat.mockImplementation(async () => ({
      isFile: () => true,
      mtimeMs: Date.now(),
    }));

    await MediaCleanup.pruneOldFiles();
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  test('handles ENOENT gracefully', async () => {
    mockReaddir.mockImplementation(async () => {
      const err = new Error('ENOENT') as any;
      err.code = 'ENOENT';
      throw err;
    });

    // Should not throw
    await MediaCleanup.pruneOldFiles();
  });
});
