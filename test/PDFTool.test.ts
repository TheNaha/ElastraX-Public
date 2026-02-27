import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

let mockFileExists = true;
let mockFileBuffer = Buffer.alloc(0);

mock.module('fs', () => ({ existsSync: () => mockFileExists }));
mock.module('fs/promises', () => ({ readFile: async () => mockFileBuffer }));

import { PDFTool } from '../src/tools/PDFTool';

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'user-1',
  senderName: 'User',
  text: '',
  isGroup: false,
  hasMedia: false,
  language: 'en',
  messageType: 'conversation',
  messageId: 'msg-1',
  mediaReady: Promise.resolve(),
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  resolveRoles: mock(async () => ['user']),
  rawMessage: {},
  ...overrides,
} as MessageContext);

beforeEach(() => {
  mockFileExists = true;
  mockFileBuffer = Buffer.alloc(0);
});

describe('PDFTool', () => {
  const tool = new PDFTool();

  test('basic properties', () => {
    expect(tool.name).toBe('pdf_tool');
    expect(tool.aliases).toContain('pdf');
    expect(tool.category).toBe('utility');
  });

  test('execute without mediaPath and no quoted mediaPath returns pdf.no_file', async () => {
    mockFileExists = false;
    const ctx = createMockCtx({ mediaPath: undefined, mimeType: undefined });
    const result = await tool.execute({ action: 'info' }, ctx);
    expect(result).toContain('attach a PDF');
  });

  test('execute with mediaPath but non-PDF mime returns pdf.not_pdf', async () => {
    mockFileExists = true;
    const ctx = createMockCtx({ mediaPath: '/tmp/file.jpg', mimeType: 'image/jpeg' });
    const result = await tool.execute({ action: 'info' }, ctx);
    expect(result).toContain('must be a PDF');
  });

  test('execute with mediaPath that does not exist on disk returns pdf.no_file', async () => {
    mockFileExists = false;
    const ctx = createMockCtx({ mediaPath: '/tmp/missing.pdf', mimeType: 'application/pdf' });
    const result = await tool.execute({ action: 'info' }, ctx);
    expect(result).toContain('attach a PDF');
  });
});
