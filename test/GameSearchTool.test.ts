import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageContext } from '../src/core/MessageContext';
import { GameSearchTool, GAME_TRUSTED_HOSTS, isTrustedGameUrl } from '../src/tools/GameSearchTool';
import { t } from '../src/utils/i18n';

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
    // A read tool's cost is never charged, so declaring one is misleading;
    // `registry.mutability.test.ts` enforces the invariant for every tool.
    expect(tool.cost).toBe(1);
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

  test('base result labels use a host-boundary trust check, not a substring', () => {
    const tool = new GameSearchTool();
    // The shipped subclasses pre-filter to trusted URLs, so call the base
    // implementation directly with a mixed set to pin the labelling rule.
    const base = Object.getPrototypeOf(GameSearchTool.prototype) as {
      formatResults: (
        lang: string,
        results: Array<{ title: string; url: string; content: string }>,
        query: string,
      ) => string;
    };
    const rendered = base.formatResults.call(tool, 'en', [
      { title: 'Real', url: 'https://fitgirl-repacks.site/pack', content: '' },
      { title: 'Suffix', url: 'https://fitgirl-repacks.site.evil.test/pack', content: '' },
      { title: 'Query', url: 'https://nottrusted.example/?u=fitgirl-repacks.site', content: '' },
    ], 'pack');
    const countLabel = (label: string): number => rendered.split(label).length - 1;
    expect(countLabel(t('en', 'search.trusted'))).toBe(1);
    expect(countLabel(t('en', 'search.untrusted'))).toBe(2);
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
