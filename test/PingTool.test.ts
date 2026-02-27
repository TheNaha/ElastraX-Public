import { expect, test, describe, mock } from 'bun:test';
import { PingTool } from '../src/tools/PingTool';
import { MessageContext } from '../src/core/MessageContext';

describe('PingTool', () => {
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

  test('should have basic properties', () => {
    const tool = new PingTool();
    expect(tool.name).toBe('ping');
    expect(tool.description).toBeString();
    expect(tool.aliases).toContain('status');
    expect(tool.aliases).toContain('uptime');
    expect(tool.category).toBe('utility');
    expect(tool.permissions).toBe('user');
  });

  test('definition should match OpenAI schema', () => {
    const tool = new PingTool();
    const def = tool.definition;

    expect(def.type).toBe('function');
    expect(def.function.name).toBe('ping');
    expect(def.function.parameters.type).toBe('object');
  });

  test('execute returns string containing latency and uptime', async () => {
    const tool = new PingTool();
    const ctx = createMockCtx({ receivedAt: Date.now() - 100 });
    const result = await tool.execute({}, ctx);

    expect(result).toBeString();
    expect(result).toContain('ms');
    expect(result).toContain('Uptime');
  });

  test('execute with no receivedAt still works', async () => {
    const tool = new PingTool();
    const ctx = createMockCtx({ receivedAt: undefined });
    const result = await tool.execute({}, ctx);

    expect(result).toBeString();
    expect(result).toContain('ms');
  });
});
