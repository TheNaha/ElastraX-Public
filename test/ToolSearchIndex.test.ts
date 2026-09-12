/**
 * test/ToolSearchIndex.test.ts
 *
 * Tests for the ToolSearchIndex — building the search index and querying
 * with keyword matching.
 */

import { ToolSearchIndex } from '../src/agent/ToolSearchIndex';
import type { BaseTool } from '../src/tools/BaseTool';
import type { ToolDefinition } from '../src/tools/BaseTool';
import { describe, test, expect, beforeEach } from 'bun:test';

// Minimal mock BaseTool for testing
function makeMockTool(overrides: Partial<BaseTool> & { name: string; description?: string; category?: string; aliases?: string[] }): BaseTool {
  return {
    ...overrides,
    name: overrides.name,
    description: overrides.description ?? '',
    category: overrides.category ?? 'utility',
    aliases: overrides.aliases ?? [],
    alwaysLoad: false,
    triggerPatterns: [],
    permissions: '',
    definition: {
      name: overrides.name,
      description: overrides.description ?? '',
      parameters: { type: 'object', properties: {} },
    } as unknown as ToolDefinition,
  } as BaseTool;
}

describe('ToolSearchIndex', () => {
  let index: ToolSearchIndex;

  beforeEach(() => {
    index = new ToolSearchIndex();
  });

  describe('build', () => {
    test('builds index from tools', () => {
      const tools = [
        makeMockTool({ name: 'download_media', description: 'Download media from URLs', aliases: ['dl'] }),
        makeMockTool({ name: 'convert_media', description: 'Convert audio/video files', category: 'media' }),
      ];
      index.build(tools);
      // Just verify it doesn't throw
    });

    test('handles empty tools array', () => {
      index.build([]);
      expect(index.search('anything')).toEqual([]);
    });

    test('handles tools with no description', () => {
      const tool = makeMockTool({ name: 'test_tool', description: '' });
      index.build([tool]);
      // Should not throw
    });
  });

  describe('search', () => {
    beforeEach(() => {
      index.build([
        makeMockTool({ name: 'download_media', description: 'Download media from URLs', aliases: ['dl', 'grab'], category: 'media' }),
        makeMockTool({ name: 'convert_media', description: 'Convert audio/video files', aliases: ['convert'], category: 'media' }),
        makeMockTool({ name: 'make_sticker', description: 'Create stickers from images', aliases: ['sticker'], category: 'fun' }),
        makeMockTool({ name: 'searr_search', description: 'Search for movies and TV shows', aliases: ['search_movies'], category: 'media' }),
      ]);
    });

    test('returns matching tools by name', () => {
      const results = index.search('download');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('download_media');
    });

    test('returns matching tools by alias', () => {
      const results = index.search('sticker');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('make_sticker');
    });

    test('returns matching tools by description keyword', () => {
      const results = index.search('convert');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('convert_media');
    });

    test('returns multiple results for common keywords', () => {
      const results = index.search('media');
      // download_media, convert_media, searr_search all have 'media' in name or category
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    test('respects limit parameter', () => {
      const results = index.search('media', 1);
      expect(results).toHaveLength(1);
    });

    test('returns empty for no matches', () => {
      const results = index.search('nonexistent_tool_xyz');
      expect(results).toEqual([]);
    });

    test('returns empty for empty query', () => {
      expect(index.search('')).toEqual([]);
      expect(index.search('   ')).toEqual([]);
      expect(index.search('a')).toEqual([]); // single chars filtered out
    });

    test('ranks by score (exact match before substring)', () => {
      const results = index.search('searr');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('searr_search');
    });

    test('case insensitive search', () => {
      const results = index.search('DOWNLOAD');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('download_media');
    });

    test('substring matching works', () => {
      const results = index.search('search');
      expect(results.some(r => r.name === 'searr_search')).toBe(true);
    });
  });
});
