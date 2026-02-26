import { expect, test, describe } from 'bun:test';
import { getToolByName, getToolByAliasOrName, getToolDefinitions, tools } from '../src/tools';

describe('Tool Registry', () => {
  test('should export a list of active tools', () => {
    expect(Array.isArray(tools)).toBeTrue();
    expect(tools.length).toBeGreaterThan(0);
  });

  test('getToolByName should return undefined for unknown tool', () => {
    const tool = getToolByName('not_a_real_tool');
    expect(tool).toBeUndefined();
  });

  test('getToolByName should return the tool if it exists', () => {
    const tool = getToolByName('web_search');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('web_search');
  });

  test('getToolDefinitions should return an array of schemas', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBeTrue();
    expect(defs.length).toEqual(tools.length);
    if (defs.length > 0) {
      expect(defs[0].type).toBe('function');
    }
  });

  describe('getToolByAliasOrName', () => {
    test('should return tool by exact name', () => {
      const targetTool = tools[0];
      const tool = getToolByAliasOrName(targetTool.name);
      expect(tool).toBeDefined();
      expect(tool?.name).toBe(targetTool.name);
    });

    test('should return tool by alias', () => {
      const targetTool = tools.find(t => t.aliases.length > 0);
      if (!targetTool) {
        // Skip test if no tool with aliases exists, but we expect at least one
        console.warn('No tool with aliases found for testing');
        return;
      }
      const alias = targetTool.aliases[0];
      const tool = getToolByAliasOrName(alias);
      expect(tool).toBeDefined();
      expect(tool?.name).toBe(targetTool.name);
    });

    test('should return undefined for unknown tool', () => {
      const tool = getToolByAliasOrName('non_existent_tool_xyz');
      expect(tool).toBeUndefined();
    });
  });
});
