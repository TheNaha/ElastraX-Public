import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageContext } from '../src/core/MessageContext';
import { GameSearchTool, GAME_TRUSTED_HOSTS, isTrustedGameUrl } from '../src/tools/GameSearchTool';

const originalGameSearch = process.env.ENABLE_GAME_SEARCH;
const originalSearxngUrl = process.env.SEARXNG_URL;

describe('GameSearchTool', () => {
  beforeEach(() => {
    process.env.SEARXNG_URL = 'https://test.searxng.local';
  });

  afterEach(() => {
    if (originalGameSearch === undefined) delete process.env.ENABLE_GAME_SEARCH;
    else process.env.ENABLE_GAME_SEARCH = originalGameSearch;
    if (originalSearxngUrl === undefined) delete process.env.SEARXNG_URL;
    else process.env.SEARXNG_URL = originalSearxngUrl;
  });

  test('should have basic properties', () => {
    const tool = new GameSearchTool();
    expect(tool.name).toBe('game_search');
    expect(tool.description).toBeString();
    expect(tool.aliases).toContain('searchgame');
    expect(tool.aliases).toContain('findgame');
    expect(tool.category).toBe('utility');
    expect(tool.permissions).toBe('user');
    expect(tool.optIn).toBe(true);
    expect(tool.optInFlag).toBe('ENABLE_GAME_SEARCH');
    expect(tool.alwaysLoad).toBe(false);
    expect(tool.cost).toBe(2);
  });

  test('definition should match OpenAI schema', () => {
    const tool = new GameSearchTool();
    const def = tool.definition;

    expect(def.type).toBe('function');
    expect(def.function.name).toBe('game_search');
    expect(def.function.parameters.type).toBe('object');
    expect(def.function.parameters.required).toContain('query');
    expect(def.function.parameters.properties.query).toBeObject();
  });

  test('should expose the expected trusted hosts', () => {
    expect(GAME_TRUSTED_HOSTS.length).toBeGreaterThan(0);
    expect(GAME_TRUSTED_HOSTS).toContain('fitgirl-repacks.site');
    expect(GAME_TRUSTED_HOSTS).toContain('steamrip.com');
    expect(GAME_TRUSTED_HOSTS).toContain('dodi-repacks.site');
    expect(GAME_TRUSTED_HOSTS).toContain('gog-games.to');
  });

  test('isTrustedGameUrl should recognize trusted hostnames', () => {
    expect(isTrustedGameUrl('https://fitgirl-repacks.site/pack')).toBe(true);
    expect(isTrustedGameUrl('https://steamrip.com/game')).toBe(true);
    expect(isTrustedGameUrl('https://dodi-repacks.site/title')).toBe(true);
  });

  test('isTrustedGameUrl should reject untrusted hostnames', () => {
    expect(isTrustedGameUrl('https://example.com')).toBe(false);
    expect(isTrustedGameUrl('https://google.com')).toBe(false);
  });

  test('execute returns disabled message when opt-in flag is missing', async () => {
    delete process.env.ENABLE_GAME_SEARCH;
    const tool = new GameSearchTool();
    const result = await tool.execute({ query: '' }, {} as MessageContext);
    expect(result).toBeString();
    expect(result.toLowerCase()).toContain('disabled');
  });

  test('execute without query returns error when enabled', async () => {
    process.env.ENABLE_GAME_SEARCH = 'true';
    const tool = new GameSearchTool();
    const result = await tool.execute({ query: '' }, {} as MessageContext);
    expect(result).toBeString();
    expect(result.toLowerCase()).toContain('query');
  });
});
