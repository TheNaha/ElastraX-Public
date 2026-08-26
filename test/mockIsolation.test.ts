import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'events';
import type { MessageContext } from '../src/core/MessageContext';
import { DownloadTool, downloadToolDeps } from '../src/tools/DownloadTool';
import { FFmpegConverter, ffmpegConverterDeps } from '../src/utils/FFmpegConverter';

const originalDownloadSpawn = downloadToolDeps.spawn;
const originalDownloadMkdir = downloadToolDeps.fs.mkdir;
const originalDownloadReaddir = downloadToolDeps.fs.readdir;
const originalDownloadReadFile = downloadToolDeps.fs.readFile;
const originalDownloadRm = downloadToolDeps.fs.rm;
const originalDownloadCrypto = downloadToolDeps.crypto;

const originalFfmpegSpawn = ffmpegConverterDeps.spawn;
const originalFfmpegMkdir = ffmpegConverterDeps.fs.mkdir;
const originalFfmpegWriteFile = ffmpegConverterDeps.fs.writeFile;
const originalFfmpegReadFile = ffmpegConverterDeps.fs.readFile;
const originalFfmpegUnlink = ffmpegConverterDeps.fs.unlink;
const originalFfmpegCrypto = ffmpegConverterDeps.crypto;

const createMockCtx = (): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'user-1',
  senderName: 'Alice',
  text: '',
  messageType: 'conversation',
  isGroup: false,
  isBotMentioned: false,
  hasMedia: false,
  rawMessage: {},
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  resolveRoles: mock(async () => ['user']),
  messageId: 'msg-1',
  mediaReady: Promise.resolve(),
  sendMedia: mock(async () => {}),
  language: 'en',
}) as unknown as MessageContext;

describe('Mock isolation regression', () => {
  beforeEach(() => {
    downloadToolDeps.fs.mkdir = mock(async () => {}) as typeof downloadToolDeps.fs.mkdir;
    downloadToolDeps.fs.readdir = mock(async () => ['feedfacecafebeef.mp4']) as unknown as typeof downloadToolDeps.fs.readdir;
    downloadToolDeps.fs.readFile = mock(async () => Buffer.from('video-bytes')) as unknown as typeof downloadToolDeps.fs.readFile;
    downloadToolDeps.fs.rm = mock(async () => {}) as typeof downloadToolDeps.fs.rm;
    downloadToolDeps.crypto = {
      ...originalDownloadCrypto,
      randomBytes: mock((size: number) => {
        if (size === 8) return Buffer.from('feedfacecafebeef', 'hex');
        return Buffer.from('ab'.repeat(size), 'hex');
      }),
    } as typeof downloadToolDeps.crypto;

    ffmpegConverterDeps.fs.mkdir = mock(async () => {}) as typeof ffmpegConverterDeps.fs.mkdir;
    ffmpegConverterDeps.fs.writeFile = mock(async () => {}) as typeof ffmpegConverterDeps.fs.writeFile;
    ffmpegConverterDeps.fs.readFile = mock(async () => Buffer.from('webp-bytes')) as unknown as typeof ffmpegConverterDeps.fs.readFile;
    ffmpegConverterDeps.fs.unlink = mock(async () => {}) as typeof ffmpegConverterDeps.fs.unlink;
    ffmpegConverterDeps.crypto = {
      ...originalFfmpegCrypto,
      randomBytes: mock((size: number) => Buffer.from('cd'.repeat(size), 'hex')),
    } as typeof ffmpegConverterDeps.crypto;
  });

  afterEach(() => {
    downloadToolDeps.spawn = originalDownloadSpawn;
    downloadToolDeps.fs.mkdir = originalDownloadMkdir;
    downloadToolDeps.fs.readdir = originalDownloadReaddir;
    downloadToolDeps.fs.readFile = originalDownloadReadFile;
    downloadToolDeps.fs.rm = originalDownloadRm;
    downloadToolDeps.crypto = originalDownloadCrypto;

    ffmpegConverterDeps.spawn = originalFfmpegSpawn;
    ffmpegConverterDeps.fs.mkdir = originalFfmpegMkdir;
    ffmpegConverterDeps.fs.writeFile = originalFfmpegWriteFile;
    ffmpegConverterDeps.fs.readFile = originalFfmpegReadFile;
    ffmpegConverterDeps.fs.unlink = originalFfmpegUnlink;
    ffmpegConverterDeps.crypto = originalFfmpegCrypto;
  });

  test('DownloadTool and FFmpegConverter can be mocked independently in the same test process', async () => {
    const downloadSpawn = mock((_command: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; stdout: EventEmitter };
      child.stderr = new EventEmitter();
      child.stdout = new EventEmitter();
      setTimeout(() => child.emit('close', 0), 10);
      return Object.assign(child, { args }) as never;
    });
    const ffmpegSpawn = mock(() => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      setTimeout(() => child.emit('close', 0), 10);
      return child as never;
    });

    downloadToolDeps.spawn = downloadSpawn as unknown as typeof downloadToolDeps.spawn;
    ffmpegConverterDeps.spawn = ffmpegSpawn as typeof ffmpegConverterDeps.spawn;

    const downloadResult = await new DownloadTool().execute(
      { url: 'https://example.com/video', format: 'mp4' },
      createMockCtx(),
    );
    const converted = await FFmpegConverter.convert(Buffer.from('input'), ['-vf', 'scale=256:256'], 'png', 'webp');

    expect(downloadResult).toContain('Download complete');
    expect(converted.toString()).toBe('webp-bytes');
    expect(downloadSpawn).toHaveBeenCalledTimes(1);
    expect(ffmpegSpawn).toHaveBeenCalledTimes(1);
  });
});
