import { expect, test, describe, mock } from 'bun:test';
import { MakeStickerTool } from '../src/tools/MakeStickerTool';
import { MessageContext } from '../src/core/MessageContext';

mock.module('../src/utils/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-123',
  senderId: 'user-456',
  senderName: 'Alice',
  text: '',
  isGroup: false,
  hasMedia: false,
  rawMessage: {},
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  ...overrides,
});

describe('MakeStickerTool', () => {
  test('should have correct name and metadata', () => {
    const tool = new MakeStickerTool();
    expect(tool.name).toBe('sticker');
    expect(tool.aliases).toContain('s');
    expect(tool.aliases).toContain('makesticker');
    expect(tool.aliases).toContain('createsticker');
    expect(tool.category).toBe('media');
    expect(tool.permissions).toBe('user');
  });

  test('definition should match OpenAI schema', () => {
    const tool = new MakeStickerTool();
    const def = tool.definition;
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('sticker');
    // packname and author are optional
    expect(def.function.parameters.required).toHaveLength(0);
    expect(def.function.parameters.properties['packname']).toBeDefined();
    expect(def.function.parameters.properties['author']).toBeDefined();
  });

  test('should return error if message has no media and no quoted media', async () => {
    const tool = new MakeStickerTool();
    const ctx = createMockCtx({ hasMedia: false });
    const result = await tool.execute({}, ctx);
    expect(result).toContain('❌ I need an image or video');
  });

  test('should return error if downloadMedia is not supported', async () => {
    const tool = new MakeStickerTool();
    const ctx = createMockCtx({
      hasMedia: true,
      downloadMedia: undefined,
      rawMessage: { message: { imageMessage: { mimetype: 'image/jpeg' } } },
    });
    const result = await tool.execute({}, ctx);
    expect(result).toContain('❌ Downloading media is not supported');
  });

  test('should return error if downloadMedia returns null', async () => {
    const tool = new MakeStickerTool();
    const ctx = createMockCtx({
      hasMedia: true,
      downloadMedia: mock(async () => null),
      rawMessage: { message: { imageMessage: { mimetype: 'image/jpeg' } } },
    });
    const result = await tool.execute({}, ctx);
    expect(result).toContain('❌ Failed to download the media');
  });

  test('should react with ⏳ when processing starts', async () => {
    const tool = new MakeStickerTool();
    // downloadMedia returns null, so it bails early after reacting
    const ctx = createMockCtx({
      hasMedia: true,
      downloadMedia: mock(async () => null),
      rawMessage: { message: { imageMessage: { mimetype: 'image/jpeg' } } },
    });
    await tool.execute({}, ctx);
    expect(ctx.react).toHaveBeenCalledWith('⏳');
  });
});
