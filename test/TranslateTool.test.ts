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

  test('definition should match OpenAI schema', () => {
    const tool = new TranslateTool();
    const def = tool.definition;

    expect(def.type).toBe('function');
    expect(def.function.name).toBe('translate');
    expect(def.function.parameters.required).toContain('target_language');
  });

  describe('execute', () => {
    test('should call chatCompletion and return translated text', async () => {
      const tool = new TranslateTool();
      const ctx = createMockCtx();
      const result = await tool.execute({ target_language: 'Spanish', text: 'Hello world' }, ctx);

      expect(mockChatCompletion).toHaveBeenCalled();
      expect(result).toContain('Hola mundo');
    });

    test('should return no_text error when no text and no quoted', async () => {
      const tool = new TranslateTool();
      const ctx = createMockCtx({ quoted: undefined });
      const result = await tool.execute({ target_language: 'Spanish' }, ctx);

      expect(result).toContain('provide text');
    });

    test('should use quoted text when no explicit text provided', async () => {
      const tool = new TranslateTool();
      const ctx = createMockCtx({
        quoted: { text: 'Quoted message text' } as any,
      });
      const result = await tool.execute({ target_language: 'Spanish' }, ctx);

      expect(mockChatCompletion).toHaveBeenCalled();
      expect(result).toContain('Hola mundo');
    });

    test('should return error when LLM returns empty content', async () => {
      const tool = new TranslateTool();
      mockChatCompletion.mockImplementation(async () => ({ content: '', role: 'assistant' }));
      const ctx = createMockCtx();
      const result = await tool.execute({ target_language: 'Spanish', text: 'Hello' }, ctx);

      expect(result).toContain('failed');
    });
  });
});
