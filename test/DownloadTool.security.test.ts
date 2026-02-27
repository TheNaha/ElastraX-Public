import { describe, test, expect, mock, afterEach } from 'bun:test';
import { DownloadTool } from '../src/tools/DownloadTool';
import { MessageContext } from '../src/core/MessageContext';
import { EventEmitter } from 'events';

// Mock logger
mock.module('../src/utils/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

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
});
