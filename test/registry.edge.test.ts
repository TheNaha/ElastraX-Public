import { expect, test, describe } from 'bun:test';
import { getToolByAliasOrName, getToolByName, getToolDefinitions, tools } from '../src/tools';

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
});
