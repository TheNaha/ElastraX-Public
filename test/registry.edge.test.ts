import { expect, test, describe } from 'bun:test';
import { getAuthorizedTool, getToolByAliasOrName, getToolByName, getToolDefinitions, tools } from '../src/tools';
import type { MessageContext } from '../src/core/MessageContext';

function stubContext(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    platform: 'whatsapp',
    chatId: 'chat-1',
    senderId: 'user-1',
    isGroup: false,
    ...overrides,
  } as unknown as MessageContext;
}

describe('Tool Registry – edge cases', () => {
  test('getToolByAliasOrName should find a tool by its canonical name', () => {
    const tool = getToolByAliasOrName('web_search');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('web_search');
  });

  test('getToolByAliasOrName should find a tool by alias', () => {
    // 'sticker' tool has alias 's'
    const tool = getToolByAliasOrName('s');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('sticker');
  });

  test('getToolByAliasOrName should return undefined for unknown name or alias', () => {
    const tool = getToolByAliasOrName('definitely_not_a_tool');
    expect(tool).toBeUndefined();
  });

  test('every registered tool should have a non-empty name', () => {
    for (const tool of tools) {
      expect(tool.name.length).toBeGreaterThan(0);
    }
  });

  test('every registered tool should have a valid permissions value', () => {
    const valid = ['user', 'admin', 'owner'];
    for (const tool of tools) {
      expect(valid).toContain(tool.permissions);
    }
  });

  test('every tool definition should have a type of "function"', () => {
    for (const def of getToolDefinitions()) {
      expect(def.type).toBe('function');
    }
  });

  test('every tool definition should have a non-empty function name', () => {
    for (const def of getToolDefinitions()) {
      expect(def.function.name.length).toBeGreaterThan(0);
    }
  });

  test('getToolByName should find the menu tool', () => {
    const tool = getToolByName('menu');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('menu');
  });

  test('getToolByName should find the sticker tool', () => {
    const tool = getToolByName('sticker');
    expect(tool).toBeDefined();
  });

  test('getToolByName should find the language tool', () => {
    const tool = getToolByName('language');
    expect(tool).toBeDefined();
  });

  test('getToolByName should find the groupadmin tool', () => {
    const tool = getToolByName('groupadmin');
    expect(tool).toBeDefined();
  });

  test('getAuthorizedTool refuses a tool the run denied by name', async () => {
    // The slash path must honour `deniedToolNames` just like the model path does.
    expect(await getAuthorizedTool('reminder', stubContext())).toBeDefined();
    expect(await getAuthorizedTool('reminder', stubContext({ deniedToolNames: ['reminder'] }))).toBeUndefined();
  });
});
