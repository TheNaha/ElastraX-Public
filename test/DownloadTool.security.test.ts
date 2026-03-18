import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'events';
import type { MessageContext } from '../src/core/MessageContext';
import { DownloadTool, downloadToolDeps } from '../src/tools/DownloadTool';

const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};

mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

const originalSpawn = downloadToolDeps.spawn;
const originalMkdir = downloadToolDeps.fs.mkdir;
const originalReaddir = downloadToolDeps.fs.readdir;
const originalReadFile = downloadToolDeps.fs.readFile;
const originalRm = downloadToolDeps.fs.rm;
const originalCrypto = downloadToolDeps.crypto;

let spawnedProcesses: Array<{ args: string[] }> = [];

const mockSpawn = mock((_command: string, args: string[]) => {
  const cp = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdout: EventEmitter;
    pid: number;
    args: string[];
  };
  cp.stderr = new EventEmitter();
  cp.stdout = new EventEmitter();
  cp.pid = 123;
  cp.args = args;

  setTimeout(() => {
    cp.emit('close', 0);
  }, 10);

  spawnedProcesses.push({ args });
  return cp as never;
});

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
});

describe('DownloadTool Security', () => {
  beforeEach(() => {
    spawnedProcesses = [];
    mockSpawn.mockClear();

    downloadToolDeps.spawn = mockSpawn as typeof downloadToolDeps.spawn;
    downloadToolDeps.fs.mkdir = mock(async () => {}) as typeof downloadToolDeps.fs.mkdir;
    downloadToolDeps.fs.readdir = mock(async () => ['feedfacecafebeef.mp4']) as typeof downloadToolDeps.fs.readdir;
    downloadToolDeps.fs.readFile = mock(async () => Buffer.from('video-bytes')) as typeof downloadToolDeps.fs.readFile;
    downloadToolDeps.fs.rm = mock(async () => {}) as typeof downloadToolDeps.fs.rm;
    downloadToolDeps.crypto = {
      ...originalCrypto,
      randomBytes: mock((size: number) => {
        if (size === 8) return Buffer.from('feedfacecafebeef', 'hex');
        return Buffer.from('ab'.repeat(size), 'hex');
      }),
    } as typeof downloadToolDeps.crypto;
  });

  afterEach(() => {
    downloadToolDeps.spawn = originalSpawn;
    downloadToolDeps.fs.mkdir = originalMkdir;
    downloadToolDeps.fs.readdir = originalReaddir;
    downloadToolDeps.fs.readFile = originalReadFile;
    downloadToolDeps.fs.rm = originalRm;
    downloadToolDeps.crypto = originalCrypto;
  });

  test('should reject argument injection vectors (starting with -) due to URL validation', async () => {
    const tool = new DownloadTool();
    const maliciousUrl = '--version';

    const result = await tool.execute({ url: maliciousUrl, format: 'mp4' }, createMockCtx());

    expect(result).toContain('Invalid URL format');
    expect(spawnedProcesses.length).toBe(0);
  });

  test('should reject file:// protocol to prevent SSRF/LFI', async () => {
    const tool = new DownloadTool();
    const localFileUrl = 'file:///etc/passwd';

    const result = await tool.execute({ url: localFileUrl, format: 'mp4' }, createMockCtx());

    expect(result).toContain('Only HTTP/HTTPS URLs are allowed');
    expect(spawnedProcesses.length).toBe(0);
  });

  test('should pass valid URLs safely after -- separator', async () => {
    const tool = new DownloadTool();
    const validUrl = 'https://example.com/video';

    await tool.execute({ url: validUrl, format: 'mp4' }, createMockCtx());

    const cp = spawnedProcesses[0];
    expect(cp).toBeDefined();

    const args = cp.args;
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe(validUrl);
  });

  test('should detect and block path traversal in output filename', async () => {
    const tool = new DownloadTool();

    downloadToolDeps.crypto = {
      ...originalCrypto,
      randomBytes: mock((size: number) => {
        if (size === 8) return Buffer.from('deadbeefdeadbeef', 'hex');
        return Buffer.from('cd'.repeat(size), 'hex');
      }),
    } as typeof downloadToolDeps.crypto;
    downloadToolDeps.fs.readdir = mock(async () => ['deadbeefdeadbeef/../../../etc/passwd']) as typeof downloadToolDeps.fs.readdir;

    const result = await tool.execute({ url: 'https://example.com/video', format: 'mp4' }, createMockCtx());

    expect(result).toContain('Invalid output filename');
  });

  test('should reject prototype pollution vectors in format parameter', async () => {
    const tool = new DownloadTool();

    const result = await tool.execute(
      { url: 'https://example.com/video', format: '__proto__' as never },
      createMockCtx(),
    );

    expect(result).toContain('Invalid format requested');
    expect(spawnedProcesses.length).toBe(0);
  });
});
