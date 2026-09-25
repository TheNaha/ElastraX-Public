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
const originalFfmpegStat = ffmpegConverterDeps.fs.stat;
const originalFfmpegChmod = ffmpegConverterDeps.fs.chmod;
const originalFfmpegRm = ffmpegConverterDeps.fs.rm;
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

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { end: (chunk?: Uint8Array) => void; destroyed: boolean };
  kill: (signal?: NodeJS.Signals) => boolean;
  killed: boolean;
  pid?: number;
  args?: string[];
};

function createFakeChild(args: string[] = [], pid?: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end: () => undefined, destroyed: true }) as FakeChild['stdin'];
  child.kill = () => {
    child.killed = true;
    return true;
  };
  child.killed = false;
  if (pid !== undefined) child.pid = pid;
  child.args = args;
  return child;
}

describe('Mock isolation regression', () => {
  beforeEach(() => {
    downloadToolDeps.fs.mkdir = mock(async () => undefined) as unknown as typeof downloadToolDeps.fs.mkdir;
    downloadToolDeps.fs.readdir = mock(async () => ['feedfacecafebeef.mp4']) as unknown as typeof downloadToolDeps.fs.readdir;
    downloadToolDeps.fs.readFile = mock(async () => Buffer.from('video-bytes')) as unknown as typeof downloadToolDeps.fs.readFile;
    downloadToolDeps.fs.rm = mock(async () => undefined) as unknown as typeof downloadToolDeps.fs.rm;
    downloadToolDeps.crypto = {
      ...originalDownloadCrypto,
      randomBytes: mock((size: number) => {
        if (size === 8) return Buffer.from('feedfacecafebeef', 'hex');
        return Buffer.from('ab'.repeat(size), 'hex');
      }),
    } as typeof downloadToolDeps.crypto;

    ffmpegConverterDeps.fs.mkdir = mock(async () => undefined) as unknown as typeof ffmpegConverterDeps.fs.mkdir;
    ffmpegConverterDeps.fs.chmod = mock(async () => undefined) as unknown as typeof ffmpegConverterDeps.fs.chmod;
    ffmpegConverterDeps.fs.writeFile = mock(async () => undefined) as unknown as typeof ffmpegConverterDeps.fs.writeFile;
    ffmpegConverterDeps.fs.readFile = mock(async () => Buffer.from('webp-bytes')) as unknown as typeof ffmpegConverterDeps.fs.readFile;
    ffmpegConverterDeps.fs.unlink = mock(async () => undefined) as unknown as typeof ffmpegConverterDeps.fs.unlink;
    ffmpegConverterDeps.fs.rm = mock(async () => undefined) as unknown as typeof ffmpegConverterDeps.fs.rm;
    ffmpegConverterDeps.fs.stat = mock(async () => ({ isFile: () => true, size: 10 })) as unknown as typeof ffmpegConverterDeps.fs.stat;
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
    ffmpegConverterDeps.fs.stat = originalFfmpegStat;
    ffmpegConverterDeps.fs.chmod = originalFfmpegChmod;
    ffmpegConverterDeps.fs.rm = originalFfmpegRm;
    ffmpegConverterDeps.crypto = originalFfmpegCrypto;
  });

  test('DownloadTool and FFmpegConverter can be mocked independently in the same test process', async () => {
    const downloadSpawn = mock((_command: string, args: string[]) => {
      const child = createFakeChild(args);
      setTimeout(() => child.emit('close', 0, null), 10);
      return child as never;
    });
    const ffmpegSpawn = mock(() => {
      const child = createFakeChild();
      setTimeout(() => child.emit('close', 0, null), 10);
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

  test('each tool keeps its own spawn dependency after a failure in the other', async () => {
    const downloadSpawn = mock(() => {
      throw new Error('yt-dlp is unavailable');
    });
    const ffmpegSpawn = mock(() => {
      const child = createFakeChild();
      setTimeout(() => child.emit('close', 0, null), 10);
      return child as never;
    });
    downloadToolDeps.spawn = downloadSpawn as unknown as typeof downloadToolDeps.spawn;
    ffmpegConverterDeps.spawn = ffmpegSpawn as typeof ffmpegConverterDeps.spawn;

    const downloadResult = await new DownloadTool().execute({ url: 'https://example.com/video', format: 'mp4' }, createMockCtx());
    expect(downloadResult).toContain('yt-dlp is unavailable');
    expect(downloadResult).not.toContain('Download complete');
    expect(downloadSpawn).toHaveBeenCalledTimes(1);

    const converted = await FFmpegConverter.convert(Buffer.from('input'), ['-vf', 'scale=256:256'], 'png', 'webp');
    expect(converted.toString()).toBe('webp-bytes');
    expect(ffmpegSpawn).toHaveBeenCalledTimes(1);
  });
});
