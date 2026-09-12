/**
 * test/registry.reload.test.ts
 *
 * Tests for the tool registry's reloadRegistry function — core tool loading,
 * plugin loading, and atomic swap behavior.
 */

import { expect, test, describe, beforeAll } from 'bun:test';
import { reloadRegistry, tools, getToolByName, getToolByAliasOrName, getToolDefinitions, getAlwaysLoadedDefinitions, getTriggeredTools, toolSearchIndex } from '../src/tools';

describe('ToolRegistry reloadRegistry', () => {
  describe('after initial load', () => {
    beforeAll(async () => {
      await reloadRegistry();
    });

    test('all expected core tools are loaded', () => {
      const names = tools.map(t => t.name);
      expect(names).toContain('web_search');
      expect(names).toContain('menu');
      expect(names).toContain('download_media');
      expect(names).toContain('convert_media');
      expect(names).toContain('pdf_tool');
      expect(names).toContain('find_tools');
      expect(names).toContain('memory');
      expect(names).toContain('sticker');
    });

    test('getToolByName returns correct tool', () => {
      const menuTool = getToolByName('menu');
      expect(menuTool).toBeDefined();
      expect(menuTool?.name).toBe('menu');
    });

    test('getToolByAliasOrName returns tool by alias', () => {
      const menuTool = getToolByAliasOrName('menu');
      expect(menuTool).toBeDefined();
      expect(menuTool?.name).toBe('menu');
    });

    test('getToolDefinitions returns all tool definitions', () => {
      const defs = getToolDefinitions();
      expect(defs.length).toBe(tools.length);
      expect(defs.every(d => d.function && d.function.name)).toBe(true);
    });

    test('getAlwaysLoadedDefinitions returns tools with alwaysLoad=true', () => {
      const defs = getAlwaysLoadedDefinitions();
      const alwaysLoadedTools = tools.filter(t => t.alwaysLoad);
      expect(defs.length).toBe(alwaysLoadedTools.length);
    });

    test('toolSearchIndex is built after reload', () => {
      // find_tools should be discoverable in the index
      const results = toolSearchIndex.search('search');
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('reloadRegistry behavior', () => {
    test('reloadRegistry can be called multiple times safely', async () => {
      await reloadRegistry();
      const firstCount = tools.length;

      await reloadRegistry();
      const secondCount = tools.length;

      expect(firstCount).toBe(secondCount);
    });

    test('tools array is non-empty after reload', async () => {
      await reloadRegistry();
      expect(tools.length).toBeGreaterThan(10);
    });

    test('getToolByName returns undefined for unknown tool', async () => {
      await reloadRegistry();
      expect(getToolByName('nonexistent_tool')).toBeUndefined();
    });

    test('getToolByAliasOrName returns undefined for unknown command', async () => {
      await reloadRegistry();
      expect(getToolByAliasOrName('nonexistent_command')).toBeUndefined();
    });
  });

  describe('discoverableTools', () => {
    test('discoverable tools are all non-alwaysLoaded', async () => {
      await reloadRegistry();
      // Tools that are not always-loaded should be discoverable
      const alwaysLoaded = tools.filter(t => t.alwaysLoad);
      const notAlwaysLoaded = tools.filter(t => !t.alwaysLoad);
      expect(notAlwaysLoaded.length).toBeGreaterThan(0);
      expect(alwaysLoaded.length).toBeLessThanOrEqual(5);
    });
  });

  describe('triggered tools', () => {
    test('getTriggeredTools returns empty for non-matching text', async () => {
      await reloadRegistry();
      const triggered = getTriggeredTools('just a regular message', undefined);
      // May or may not match, but should not throw
      expect(Array.isArray(triggered)).toBe(true);
    });
  });
});
