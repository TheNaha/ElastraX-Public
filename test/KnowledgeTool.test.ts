import { expect, test, describe, mock } from 'bun:test';
import { KnowledgeTool } from '../src/tools/KnowledgeTool';
import type { MessageContext } from '../src/core/MessageContext';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'user-1',
  senderName: 'User',
  text: '',
  isGroup: false,
  isBotMentioned: false,
  hasMedia: false,
  receivedAt: Date.now() - 100,
  language: 'en',
  reply: mock(async () => {}),
  react: mock(async () => {}),
  rawMessage: {},
  ...overrides,
} as MessageContext);

describe('KnowledgeTool', () => {
  test('should have basic properties', () => {
    const tool = new KnowledgeTool();
    expect(tool.name).toBe('knowledge');
    expect(tool.description).toBeString();
    expect(tool.aliases).toContain('kb');
    expect(tool.aliases).toContain('docs');
    expect(tool.category).toBe('productivity');
    expect(tool.permissions).toBe('user');
    expect(tool.groupOnly).toBe(true);
  });

  test('definition should match OpenAI schema', () => {
    const tool = new KnowledgeTool();
    const def = tool.definition;

    expect(def.type).toBe('function');
    expect(def.function.name).toBe('knowledge');
    expect(def.function.parameters.type).toBe('object');
    expect(def.function.parameters.required).toContain('action');
    expect(def.function.parameters.properties.action.enum).toEqual(['index', 'search', 'list', 'remove']);
  });

  test('execute without roomKey returns no_room error', async () => {
    const tool = new KnowledgeTool();
    const ctx = createMockCtx({ roomKey: undefined });
    const result = await tool.execute({ action: 'search', query: 'test' }, ctx);
    expect(result).toBeString();
    expect(result).toContain('room');
  });

  test('execute with search action and no query returns query_required', async () => {
    const tool = new KnowledgeTool();
    const ctx = createMockCtx({ roomKey: 'room:whatsapp:chat-1' });
    const result = await tool.execute({ action: 'search', query: '' }, ctx);
    expect(result).toBeString();
    expect(result).toContain('query');
  });

  test('execute with unknown action returns undefined gracefully', async () => {
    const tool = new KnowledgeTool();
    const ctx = createMockCtx({ roomKey: 'room:whatsapp:chat-1' });
    // @ts-expect-error: testing invalid action
    const result = await tool.execute({ action: 'invalid' }, ctx);
    expect(result).toBeString();
  });
});
