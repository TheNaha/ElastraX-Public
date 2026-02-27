import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';
import { PDFTool } from '../src/tools/PDFTool';
import * as fs from 'fs';

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

describe('PDFTool', () => {
  const tool = new PDFTool();
  let existsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  afterEach(() => {
    existsSpy.mockRestore();
  });

  test('basic properties', () => {
    expect(tool.name).toBe('pdf_tool');
    expect(tool.aliases).toContain('pdf');
    expect(tool.category).toBe('utility');
  });

  test('execute without mediaPath and no quoted mediaPath returns pdf.no_file', async () => {
    existsSpy.mockReturnValue(false);
    const ctx = createMockCtx({ mediaPath: undefined, mimeType: undefined });
    const result = await tool.execute({ action: 'info' }, ctx);
    expect(result).toContain('attach a PDF');
  });

  test('execute with mediaPath but non-PDF mime returns pdf.not_pdf', async () => {
    existsSpy.mockReturnValue(true);
    const ctx = createMockCtx({ mediaPath: '/tmp/file.jpg', mimeType: 'image/jpeg' });
    const result = await tool.execute({ action: 'info' }, ctx);
    expect(result).toContain('must be a PDF');
  });

  test('execute with mediaPath that does not exist on disk returns pdf.no_file', async () => {
    existsSpy.mockReturnValue(false);
    const ctx = createMockCtx({ mediaPath: '/tmp/missing.pdf', mimeType: 'application/pdf' });
    const result = await tool.execute({ action: 'info' }, ctx);
    expect(result).toContain('attach a PDF');
  });
});
