import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  isAudioMagic,
  mediaStorageDeps,
  reconcileMediaQuota,
  saveMediaBuffer,
  saveMediaStream,
} from '../src/utils/MediaStorage';
import { HARD_MEDIA_MAX_BYTES, NORMAL_MEDIA_MAX_BYTES } from '../src/providers/media';

const original = { ...mediaStorageDeps };
const mocks = {
  mkdir: mock(async () => {}),
  chmod: mock(async () => {}),
  writeFile: mock(async (_path: string, _data: Uint8Array, _options?: { mode?: number; flag?: string }) => {}),
  readdir: mock(async () => [] as string[]),
  stat: mock(async (_file: string) => ({ isFile: () => true, size: 0, mtimeMs: Date.now() })),
  unlink: mock(async () => {}),
  rename: mock(async () => {}),
};

describe('MediaStorage', () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) value.mockClear();
    mocks.readdir.mockImplementation(async () => []);
    mocks.stat.mockImplementation(async () => ({ isFile: () => true, size: 0, mtimeMs: Date.now() }));
    mediaStorageDeps.mkdir = mocks.mkdir as never;
    mediaStorageDeps.chmod = mocks.chmod as never;
    mediaStorageDeps.writeFile = mocks.writeFile as never;
    mediaStorageDeps.readdir = mocks.readdir as never;
    mediaStorageDeps.stat = mocks.stat as never;
    mediaStorageDeps.unlink = mocks.unlink as never;
    mediaStorageDeps.rename = mocks.rename as never;
    mediaStorageDeps.randomUUID = () => 'test-uuid-1234' as ReturnType<typeof mediaStorageDeps.randomUUID>;
  });

  afterEach(() => {
    Object.assign(mediaStorageDeps, original);
  });

  test('saveMediaBuffer returns path and mime with private modes', async () => {
    const result = await saveMediaBuffer(Buffer.from('fake-image-data'));
    expect(result).not.toBeNull();
    expect(result!.path).toContain('test-uuid-1234');
    expect(result!.mime).toBeString();
    expect(mocks.mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true, mode: 0o700 });
    expect(mocks.chmod).toHaveBeenCalledWith(expect.any(String), 0o700);
    const writeOptions = mocks.writeFile.mock.calls[0]?.[2] as { mode?: number; flag?: string };
    expect(writeOptions.mode).toBe(0o600);
    expect(writeOptions.flag).toBe('wx');
  });

  test('returns null on write error', async () => {
    mocks.writeFile.mockRejectedValueOnce(new Error('disk full'));
    expect(await saveMediaBuffer(Buffer.from('fake-image-data'))).toBeNull();
  });

  test('enforces the normal and hard streaming caps before writing', async () => {
    const stream = (async function* () { yield Buffer.alloc(1); })();
    await expect(saveMediaStream(stream, { maxBytes: NORMAL_MEDIA_MAX_BYTES, contentLength: NORMAL_MEDIA_MAX_BYTES + 1 })).rejects.toThrow('limit');
    const oversized = (async function* () { yield Buffer.alloc(1); })();
    await expect(saveMediaStream(oversized, { contentLength: HARD_MEDIA_MAX_BYTES + 1 })).rejects.toThrow('limit');
  });

  test('accepts recognized audio magic without trusting MIME alone', () => {
    expect(isAudioMagic(Buffer.from([0x4f, 0x67, 0x67, 0x53]), 'application/octet-stream')).toBe(true);
    expect(isAudioMagic(Buffer.from('%PDF-1.7'), 'audio/ogg')).toBe(false);
  });

  test('quota reconciliation evicts the oldest files before accepting new media', async () => {
    const previous = process.env.MEDIA_STORAGE_MAX_MB;
    process.env.MEDIA_STORAGE_MAX_MB = '0.001024';
    mocks.readdir.mockImplementation(async () => ['new.bin', 'old.bin']);
    mocks.stat.mockImplementation(async file => ({
      isFile: () => true,
      size: 600,
      mtimeMs: String(file).endsWith('old.bin') ? 1 : 2,
    }) as never);
    try {
      const result = await reconcileMediaQuota(100);
      expect(result.deleted).toHaveLength(1);
      expect(result.deleted[0]).toContain('old.bin');
      expect(mocks.unlink).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.MEDIA_STORAGE_MAX_MB;
      else process.env.MEDIA_STORAGE_MAX_MB = previous;
    }
  });
});
