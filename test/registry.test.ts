import { expect, test, describe } from 'bun:test';
import { getToolByName, getToolDefinitions, tools } from '../src/tools';

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
});
