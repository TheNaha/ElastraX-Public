import { expect, test, describe, mock } from 'bun:test';
import { LanguageTool } from '../src/tools/LanguageTool';
import { MessageContext } from '../src/core/MessageContext';

// Controllable mock: we swap out the `where` implementation per-test
let mockWhere = mock(async () => {});

mock.module('../src/db', () => ({
  db: {
    update: () => ({
      set: () => ({
        where: (...args: any[]) => mockWhere(...args),
      }),
    }),
  },
}));

const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

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

describe('LanguageTool', () => {
  test('should have correct name and metadata', () => {
    const tool = new LanguageTool();
    expect(tool.name).toBe('language');
    expect(tool.aliases).toContain('lang');
    expect(tool.aliases).toContain('setlanguage');
    expect(tool.aliases).toContain('setlang');
    expect(tool.category).toBe('settings');
    expect(tool.permissions).toBe('user');
  });

  test('definition should match OpenAI schema with enum', () => {
    const tool = new LanguageTool();
    const def = tool.definition;

    expect(def.type).toBe('function');
    expect(def.function.name).toBe('language');
    expect(def.function.parameters.required).toContain('lang_code');

    const langCodeProp = def.function.parameters.properties['lang_code'];
    expect(langCodeProp).toBeDefined();
    expect(langCodeProp.enum).toContain('en');
    expect(langCodeProp.enum).toContain('id');
  });

  test('should return error for missing lang_code', async () => {
    const tool = new LanguageTool();
    const ctx = createMockCtx();
    const result = await tool.execute({}, ctx);
    expect(result).toContain('❌ Invalid language code');
  });

  test('should return error for invalid lang_code', async () => {
    const tool = new LanguageTool();
    const ctx = createMockCtx();
    const result = await tool.execute({ lang_code: 'fr' }, ctx);
    expect(result).toContain('❌ Invalid language code');
  });

  test('should return English success message for lang_code "en"', async () => {
    mockWhere = mock(async () => {});
    const tool = new LanguageTool();
    const ctx = createMockCtx();
    const result = await tool.execute({ lang_code: 'en' }, ctx);

    expect(ctx.react).toHaveBeenCalledWith('⏳');
    expect(result).toBe('✅ The language for this chat room has been set to English.');
  });

  test('should return Indonesian success message for lang_code "id"', async () => {
    mockWhere = mock(async () => {});
    const tool = new LanguageTool();
    const ctx = createMockCtx();
    const result = await tool.execute({ lang_code: 'id' }, ctx);

    expect(ctx.react).toHaveBeenCalledWith('⏳');
    expect(result).toBe('✅ Bahasa untuk obrolan ini telah diubah ke Bahasa Indonesia.');
  });

  test('should return error message if database update throws', async () => {
    mockWhere = mock(async () => { throw new Error('DB connection failed'); });
    const tool = new LanguageTool();
    const ctx = createMockCtx();
    const result = await tool.execute({ lang_code: 'en' }, ctx);
    expect(result).toContain('❌ Error updating language');
  });
});
