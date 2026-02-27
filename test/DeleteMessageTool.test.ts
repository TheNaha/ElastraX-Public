import { expect, test, describe, mock } from 'bun:test';
import { DeleteMessageTool } from '../src/tools/DeleteMessageTool';
import { MessageContext } from '../src/core/MessageContext';

describe('DeleteMessageTool', () => {
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

  test('should have basic properties', () => {
    const tool = new DeleteMessageTool();
    expect(tool.name).toBe('delete_message');
    expect(tool.description).toBeString();
    expect(tool.aliases).toContain('delete');
    expect(tool.aliases).toContain('del');
    expect(tool.aliases).toContain('unsend');
    expect(tool.category).toBe('utility');
  });

  test('definition should match OpenAI schema', () => {
    const tool = new DeleteMessageTool();
    const def = tool.definition;

    expect(def.type).toBe('function');
    expect(def.function.name).toBe('delete_message');
    expect(def.function.parameters.type).toBe('object');
  });

  describe('execute', () => {
    test('should return not_supported when deleteMessage is not available', async () => {
      const tool = new DeleteMessageTool();
      const ctx = createMockCtx({ deleteMessage: undefined });
      const result = await tool.execute({}, ctx);
      expect(result).toContain('not supported');
    });

    test('should return no_quoted when no quoted message', async () => {
      const tool = new DeleteMessageTool();
      const ctx = createMockCtx({
        deleteMessage: mock(async () => {}),
        quoted: undefined,
      });
      const result = await tool.execute({}, ctx);
      expect(result).toContain('reply');
    });

    test('should return not_bot_message when quoted message is not from bot', async () => {
      const tool = new DeleteMessageTool();
      const ctx = createMockCtx({
        deleteMessage: mock(async () => {}),
        quoted: {
          rawMessage: { key: { fromMe: false } },
        } as any,
      });
      const result = await tool.execute({}, ctx);
      expect(result).toContain('only delete my own');
    });

    test('should call deleteMessage and return success when quoted is from bot', async () => {
      const tool = new DeleteMessageTool();
      const mockDelete = mock(async () => {});
      const quotedKey = { fromMe: true, id: 'msg-1' };
      const ctx = createMockCtx({
        deleteMessage: mockDelete,
        quoted: {
          rawMessage: { key: quotedKey },
        } as any,
      });
      const result = await tool.execute({}, ctx);
      expect(mockDelete).toHaveBeenCalledWith(quotedKey);
      expect(result).toContain('deleted');
    });

    test('should return error message when deleteMessage throws', async () => {
      const tool = new DeleteMessageTool();
      const ctx = createMockCtx({
        deleteMessage: mock(async () => { throw new Error('Delete failed'); }),
        quoted: {
          rawMessage: { key: { fromMe: true } },
        } as any,
      });
      const result = await tool.execute({}, ctx);
      expect(result).toContain('Delete failed');
    });
  });
});
