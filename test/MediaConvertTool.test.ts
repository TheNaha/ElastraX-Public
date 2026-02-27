import { expect, test, describe, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';
import { MediaConvertTool } from '../src/tools/MediaConvertTool';
import { FFmpegConverter } from '../src/utils/FFmpegConverter';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';

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
      const convertSpy = spyOn(FFmpegConverter, 'convert').mockResolvedValue(Buffer.from('converted'));
      const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
      const readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue(Buffer.from('input-data') as any);
      const mockSendMedia = mock(async () => {});
      const ctx = createMockCtx({
        sendMedia: mockSendMedia,
        mediaPath: '/tmp/test.mp4',
        mimeType: 'video/mp4',
      });
      const result = await tool.execute({ format: 'mp3' }, ctx);

      expect(convertSpy).toHaveBeenCalled();
      expect(mockSendMedia).toHaveBeenCalled();
      expect(result).toContain('complete');
      convertSpy.mockRestore();
      existsSpy.mockRestore();
      readFileSpy.mockRestore();
    });
  });
});
