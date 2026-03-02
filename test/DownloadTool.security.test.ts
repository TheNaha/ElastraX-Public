import { describe, test, expect, mock, afterEach } from 'bun:test';
import { DownloadTool } from '../src/tools/DownloadTool';
import { MessageContext } from '../src/core/MessageContext';
import { EventEmitter } from 'events';

// Mock logger
const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

// Mock child_process
let spawnedProcesses: any[] = [];
mock.module('child_process', () => ({
  spawn: (command: string, args: string[]) => {
    const cp: any = new EventEmitter();
    cp.stderr = new EventEmitter();
    cp.stdout = new EventEmitter();
    cp.pid = 123;
    cp.command = command;
    cp.args = args;

    // Simulate immediate exit
    setTimeout(() => {
        cp.emit('close', 0);
    }, 10);

    spawnedProcesses.push(cp);
    return cp;
  },
}));

const createMockCtx = (): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'user-1',
  senderName: 'Alice',
  text: '',
  isGroup: false,
  isBotMentioned: false,
  hasMedia: false,
  rawMessage: {},
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  messageId: 'msg-1',
  mediaReady: Promise.resolve(),
  sendMedia: mock(async () => {}),
  language: 'en',
});

describe('DownloadTool Security', () => {
  afterEach(() => {
    spawnedProcesses = [];
  });

  test('should reject argument injection vectors (starting with -) due to URL validation', async () => {
    const tool = new DownloadTool();
    const maliciousUrl = '--version';

    const result = await tool.execute({ url: maliciousUrl, format: 'mp4' }, createMockCtx());

    // Should return error message about invalid URL
    expect(result).toContain('Invalid URL format');
    expect(spawnedProcesses.length).toBe(0);
  });

  test('should reject file:// protocol to prevent SSRF/LFI', async () => {
    const tool = new DownloadTool();
    const localFileUrl = 'file:///etc/passwd';

    const result = await tool.execute({ url: localFileUrl, format: 'mp4' }, createMockCtx());

    // Should return error message about protocol
    expect(result).toContain('Only HTTP/HTTPS URLs are allowed');
    expect(spawnedProcesses.length).toBe(0);
  });

  test('should pass valid URLs safely after -- separator', async () => {
    const tool = new DownloadTool();
    const validUrl = 'https://example.com/video';

    try {
        await tool.execute({ url: validUrl, format: 'mp4' }, createMockCtx());
    } catch { /* ignore expected failure due to mock fs */ }

    const cp = spawnedProcesses[0];
    expect(cp).toBeDefined();

    // Verify arguments structure
    const args = cp.args;
    const lastArg = args[args.length - 1];
    const secondLastArg = args[args.length - 2];

    expect(lastArg).toBe(validUrl);
    expect(secondLastArg).toBe('--');
  });

  test('should detect and block path traversal in output filename', async () => {
    const tool = new DownloadTool();
    const validUrl = 'https://example.com/video';

    // Mock readdir to return a filename that would match ANY 16-char hex prefix
    // We can use a spy or mock that returns what we want.
    // However, the test file uses mock.module which is global.
    // Let's use a more flexible mock for fs.promises.

    mock.module('fs', () => ({
      promises: {
        mkdir: mock(async () => {}),
        readdir: mock(async (_p: string) => {
            // In DownloadTool.ts, it calls readdir(workDir)
            // We want it to return a file that starts with the 'id' (8 bytes hex = 16 chars)
            // But we don't know the id. So we return a file that is mostly traversal.
            // Wait, the code does: const match = files.find(f => f.startsWith(id));
            // If we return a list where every entry matches, it will pick the first one.
            return ['0123456789abcdefghijklmnopqrstuvwxyz']; // This DOES NOT start with the random id
        }),
        readFile: mock(async () => Buffer.from('')),
        rm: mock(async () => {}),
      },
    }));

    // To make it match, we'd need to control crypto.randomBytes too.
    mock.module('crypto', () => ({
      randomBytes: (n: number) => {
          if (n === 8) return Buffer.from('deadbeefdeadbeef', 'hex');
          return Buffer.alloc(n, 0);
      }
    }));

    mock.module('fs', () => ({
      promises: {
        mkdir: mock(async () => {}),
        readdir: mock(async () => ['deadbeefdeadbeef/../../../etc/passwd']),
        readFile: mock(async () => Buffer.from('')),
        rm: mock(async () => {}),
      },
    }));

    const result = await tool.execute({ url: validUrl, format: 'mp4' }, createMockCtx());

    expect(result).toContain('Invalid output filename');
  });
});
