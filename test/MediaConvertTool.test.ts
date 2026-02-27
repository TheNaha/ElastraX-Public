import { expect, test, describe, mock } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';

const mockConvert = mock(async () => Buffer.from('converted'));
mock.module('../src/utils/FFmpegConverter', () => ({
  FFmpegConverter: { convert: mockConvert },
}));
mock.module('fs', () => ({ existsSync: () => true }));
mock.module('fs/promises', () => ({ readFile: async () => Buffer.from('input-data') }));

const { MediaConvertTool } = await import('../src/tools/MediaConvertTool');

describe('MediaConvertTool', () => {
  const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
    platform: 'whatsapp',
    chatId: 'chat-1',
    senderId: 'user-1',
    senderName: 'User',
    text: '',
    isGroup: false,
    hasMedia: false,
    language: 'en',
    reply: mock(async () => {}),
    react: mock(async () => {}),
    rawMessage: {},
    ...overrides,
  } as MessageContext);

  test('should have basic properties', () => {
    const tool = new MediaConvertTool();
    expect(tool.name).toBe('convert_media');
    expect(tool.description).toBeString();
    expect(tool.aliases).toContain('convert');
    expect(tool.aliases).toContain('cv');
    expect(tool.category).toBe('media');
    expect(tool.permissions).toBe('user');
  });

  test('definition should match OpenAI schema', () => {
    const tool = new MediaConvertTool();
    const def = tool.definition;

    expect(def.type).toBe('function');
    expect(def.function.name).toBe('convert_media');
    expect(def.function.parameters.required).toContain('format');
  });

  describe('execute', () => {
    test('should return error for unsupported format', async () => {
      const tool = new MediaConvertTool();
      const ctx = createMockCtx({ sendMedia: mock(async () => {}) });
      const result = await tool.execute({ format: 'xyz' }, ctx);

      expect(result).toContain('Unsupported');
    });

    test('should return not_supported when sendMedia is not available', async () => {
      const tool = new MediaConvertTool();
      const ctx = createMockCtx({ sendMedia: undefined });
      const result = await tool.execute({ format: 'mp3' }, ctx);

      expect(result).toContain('not supported');
    });

    test('should return no_media when no media and no downloadMedia', async () => {
      const tool = new MediaConvertTool();
      const ctx = createMockCtx({
        sendMedia: mock(async () => {}),
        mediaPath: undefined,
        downloadMedia: undefined,
      });
      const result = await tool.execute({ format: 'mp3' }, ctx);

      expect(result).toContain('attach');
    });

    test('should call FFmpegConverter.convert and sendMedia with valid media', async () => {
      const tool = new MediaConvertTool();
      mockConvert.mockClear();
      const mockSendMedia = mock(async () => {});
      const ctx = createMockCtx({
        sendMedia: mockSendMedia,
        mediaPath: '/tmp/test.mp4',
        mimeType: 'video/mp4',
      });
      const result = await tool.execute({ format: 'mp3' }, ctx);

      expect(mockConvert).toHaveBeenCalled();
      expect(mockSendMedia).toHaveBeenCalled();
      expect(result).toContain('complete');
    });
  });
});
