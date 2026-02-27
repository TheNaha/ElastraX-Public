import { expect, test, describe, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';
import { TranslateTool } from '../src/tools/TranslateTool';
import * as ModelRouterModule from '../src/utils/ModelRouter';

describe('TranslateTool', () => {
  const mockChatCompletion = mock(async () => ({ content: 'Hola mundo', role: 'assistant' }));
  let routerSpy: ReturnType<typeof spyOn>;

  const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
    platform: 'whatsapp',
    chatId: 'chat-1',
    senderId: 'user-1',
    senderName: 'User',
    text: '',
    isGroup: false,
    isBotMentioned: false,
    hasMedia: false,
    language: 'en',
    reply: mock(async () => {}),
    react: mock(async () => {}),
    rawMessage: {},
    ...overrides,
  } as MessageContext);

  beforeEach(() => {
    mockChatCompletion.mockClear();
    mockChatCompletion.mockImplementation(async () => ({ content: 'Hola mundo', role: 'assistant' }));
    routerSpy = spyOn(ModelRouterModule, 'getModelRouter').mockReturnValue({
      chatCompletion: mockChatCompletion,
    } as any);
  });

  afterEach(() => {
    routerSpy.mockRestore();
  });

  test('should have basic properties', () => {
    const tool = new TranslateTool();
    expect(tool.name).toBe('translate');
    expect(tool.description).toBeString();
    expect(tool.aliases).toContain('translate');
    expect(tool.aliases).toContain('tr');
    expect(tool.category).toBe('utility');
    expect(tool.permissions).toBe('user');
  });

  test('definition should match simplified schema', () => {
    const tool = new TranslateTool();
    const def = tool.definition;

    expect(def.type).toBe('function');
    expect(def.function.name).toBe('translate');
    expect(def.function.parameters.properties).toHaveProperty('query');
    expect(def.function.parameters.required).toBeUndefined(); // Query is optional
  });

  describe('execute', () => {
    test('should translate quoted text to default language when no query provided (English room)', async () => {
      const tool = new TranslateTool();
      const ctx = createMockCtx({
        quoted: { text: 'Hello world' } as any,
        language: 'en',
      });
      // Emulate /translate (no args) -> translates quoted text to English (default)

      const result = await tool.execute({ query: '' }, ctx);

      expect(mockChatCompletion).toHaveBeenCalled();
      // Verify the system prompt target language
      const callArgs = mockChatCompletion.mock.calls[0][0] as any[];
      expect(callArgs[0].content).toContain('Translate the following text to English');
      expect(result).toContain('Hola mundo');
    });

    test('should translate quoted text to default language when no query provided (Indonesian room)', async () => {
      const tool = new TranslateTool();
      const ctx = createMockCtx({
        quoted: { text: 'Hello world' } as any,
        language: 'id',
      });

      const result = await tool.execute({ query: '' }, ctx);

      const callArgs = mockChatCompletion.mock.calls[0][0] as any[];
      expect(callArgs[0].content).toContain('Translate the following text to Indonesian');
    });

    test('should translate explicit text to default language (English room)', async () => {
      const tool = new TranslateTool();
      const ctx = createMockCtx({ language: 'en' });

      // /translate Fish Stew -> 'Fish' is not a language code -> treat 'Fish Stew' as text
      const result = await tool.execute({ query: 'Fish Stew' }, ctx);

      const callArgs = mockChatCompletion.mock.calls[0][0] as any[];
      expect(callArgs[0].content).toContain('Translate the following text to English');
      expect(callArgs[1].content).toBe('Fish Stew');
    });

    test('should translate explicit text with language code (id)', async () => {
      const tool = new TranslateTool();
      const ctx = createMockCtx({ language: 'en' });

      // /translate id Good Morning
      const result = await tool.execute({ query: 'id Good Morning' }, ctx);

      const callArgs = mockChatCompletion.mock.calls[0][0] as any[];
      expect(callArgs[0].content).toContain('Translate the following text to Indonesian');
      expect(callArgs[1].content).toBe('Good Morning');
    });

    test('should translate explicit text with full language name (Spanish)', async () => {
      const tool = new TranslateTool();
      const ctx = createMockCtx({ language: 'en' });

      // /translate Spanish Good Morning
      const result = await tool.execute({ query: 'Spanish Good Morning' }, ctx);

      const callArgs = mockChatCompletion.mock.calls[0][0] as any[];
      expect(callArgs[0].content).toContain('Translate the following text to Spanish');
      expect(callArgs[1].content).toBe('Good Morning');
    });

    test('should translate quoted text with explicit language code', async () => {
      const tool = new TranslateTool();
      const ctx = createMockCtx({
        quoted: { text: 'Hello' } as any,
        language: 'en'
      });

      // /translate fr (replying to 'Hello')
      const result = await tool.execute({ query: 'fr' }, ctx);

      const callArgs = mockChatCompletion.mock.calls[0][0] as any[];
      expect(callArgs[0].content).toContain('Translate the following text to French');
      expect(callArgs[1].content).toBe('Hello');
    });

    test('should return error when no text and no quoted message', async () => {
      const tool = new TranslateTool();
      const ctx = createMockCtx({ quoted: undefined });
      const result = await tool.execute({ query: '' }, ctx);

      expect(result).toContain('provide text');
    });

    test('should handle edge case where text starts with a non-language word', async () => {
      const tool = new TranslateTool();
      const ctx = createMockCtx({ language: 'en' });

      // /translate apple pie
      const result = await tool.execute({ query: 'apple pie' }, ctx);

      const callArgs = mockChatCompletion.mock.calls[0][0] as any[];
      // 'apple' is not in LANGUAGE_MAP, so target is default (English)
      expect(callArgs[0].content).toContain('Translate the following text to English');
      expect(callArgs[1].content).toBe('apple pie');
    });

    test('should return error when LLM returns empty content', async () => {
      const tool = new TranslateTool();
      mockChatCompletion.mockImplementation(async () => ({ content: '', role: 'assistant' }));
      const ctx = createMockCtx();
      const result = await tool.execute({ query: 'Hello' }, ctx);

      expect(result).toContain('failed');
    });
  });
});
