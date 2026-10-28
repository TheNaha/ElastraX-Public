import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageContext } from '../src/core/MessageContext';
import { SoftwareSearchTool, SOFTWARE_TRUSTED_HOSTS, isTrustedSoftwareUrl } from '../src/tools/SoftwareSearchTool';

const originalSoftSearch = process.env.ENABLE_SOFTWARE_SEARCH;
const originalSearxngUrl = process.env.SEARXNG_URL;

describe('SoftwareSearchTool', () => {
  beforeEach(() => {
    process.env.SEARXNG_URL = 'https://test.searxng.local';
  });

  afterEach(() => {
    if (originalSoftSearch === undefined) delete process.env.ENABLE_SOFTWARE_SEARCH;
    else process.env.ENABLE_SOFTWARE_SEARCH = originalSoftSearch;
    if (originalSearxngUrl === undefined) delete process.env.SEARXNG_URL;
    else process.env.SEARXNG_URL = originalSearxngUrl;
  });

  test('should have basic properties', () => {
    const tool = new SoftwareSearchTool();
    expect(tool.name).toBe('software_search');
    expect(tool.description).toBeString();
    expect(tool.aliases).toContain('searchsoftware');
    expect(tool.aliases).toContain('findsoftware');
    expect(tool.category).toBe('utility');
    expect(tool.permissions).toBe('user');
    expect(tool.optIn).toBe(true);
    expect(tool.optInFlag).toBe('ENABLE_SOFTWARE_SEARCH');
    expect(tool.alwaysLoad).toBe(false);
    expect(tool.cost).toBe(2);
  });

  test('definition should match OpenAI schema', () => {
    const tool = new SoftwareSearchTool();
    const def = tool.definition;

    expect(def.type).toBe('function');
    expect(def.function.name).toBe('software_search');
    expect(def.function.parameters.type).toBe('object');
    expect(def.function.parameters.required).toContain('query');
    expect(def.function.parameters.properties.query).toBeObject();
  });

  test('should expose the expected trusted hosts', () => {
    expect(SOFTWARE_TRUSTED_HOSTS.length).toBeGreaterThan(0);
    expect(SOFTWARE_TRUSTED_HOSTS).toContain('filecr.com');
    expect(SOFTWARE_TRUSTED_HOSTS).toContain('rsload.net');
    expect(SOFTWARE_TRUSTED_HOSTS).toContain('fmhy.net');
  });

  test('isTrustedSoftwareUrl should recognize trusted hostnames', () => {
    expect(isTrustedSoftwareUrl('https://filecr.com/file')).toBe(true);
    expect(isTrustedSoftwareUrl('https://rsload.net/app')).toBe(true);
    expect(isTrustedSoftwareUrl('https://fmhy.net/guide')).toBe(true);
  });

  test('isTrustedSoftwareUrl should reject untrusted hostnames', () => {
    expect(isTrustedSoftwareUrl('https://example.com')).toBe(false);
    expect(isTrustedSoftwareUrl('https://google.com')).toBe(false);
  });

  test('execute returns disabled message when opt-in flag is missing', async () => {
    delete process.env.ENABLE_SOFTWARE_SEARCH;
    const tool = new SoftwareSearchTool();
    const result = await tool.execute({ query: '' }, {} as MessageContext);
    expect(result).toBeString();
    expect(result.toLowerCase()).toContain('disabled');
  });

  test('execute without query returns error when enabled', async () => {
    process.env.ENABLE_SOFTWARE_SEARCH = 'true';
    const tool = new SoftwareSearchTool();
    const result = await tool.execute({ query: '' }, {} as MessageContext);
    expect(result).toBeString();
    expect(result.toLowerCase()).toContain('query');
  });
});
