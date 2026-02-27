import { expect, test, describe, mock } from 'bun:test';
import { IDTool } from '../src/tools/IDTool';
import { MessageContext } from '../src/core/MessageContext';

describe('IDTool', () => {
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
    resolveRoles: mock(async () => ['user']),
    rawMessage: {},
    ...overrides,
  } as MessageContext);

  test('should have basic properties', () => {
    const tool = new IDTool();
    expect(tool.name).toBe('get_id');
    expect(tool.description).toBeString();
    expect(tool.aliases).toContain('id');
    expect(tool.aliases).toContain('whoami');
    expect(tool.category).toBe('utility');
    expect(tool.permissions).toBe('user');
  });

  test('definition should match OpenAI schema', () => {
    const tool = new IDTool();
    const def = tool.definition;

    expect(def.type).toBe('function');
    expect(def.function.name).toBe('get_id');
    expect(def.function.parameters.type).toBe('object');
  });

  test('execute returns string containing userId, chatId, platform, senderName', async () => {
    const tool = new IDTool();
    const ctx = createMockCtx();
    const result = await tool.execute({}, ctx);

    expect(result).toBeString();
    expect(result).toContain('user-1');
    expect(result).toContain('chat-1');
    expect(result).toContain('whatsapp');
    expect(result).toContain('User');
    // Note: We expect the result to contain 'user' eventually when we implement the change
  });

  test('execute with isGroup=true shows Yes', async () => {
    const tool = new IDTool();
    const ctx = createMockCtx({ isGroup: true });
    const result = await tool.execute({}, ctx);

    expect(result).toContain('Yes');
  });

  test('execute with isGroup=false shows No', async () => {
    const tool = new IDTool();
    const ctx = createMockCtx({ isGroup: false });
    const result = await tool.execute({}, ctx);

    expect(result).toContain('No');
  });

  test('execute shows multiple roles', async () => {
    const tool = new IDTool();
    const ctx = createMockCtx({
        resolveRoles: mock(async () => ['user', 'admin'])
    });

    const result = await tool.execute({}, ctx);
    expect(result).toBeString();
    expect(result).toContain('user, admin');
  });
});
