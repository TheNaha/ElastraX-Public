import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageContext } from '../src/core/MessageContext';
import net from 'node:net';
import { ssrfDeps } from '../src/providers/ssrf';
import { WebScrapeTool } from '../src/tools/WebScrapeTool';

const createMockCtx = (): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'user-1',
  senderName: 'User',
  text: '',
  isGroup: false,
  isBotMentioned: false,
  hasMedia: false,
  rawMessage: {},
  reply: mock(async () => {}),
  react: mock(async () => {}),
} as unknown as MessageContext);

describe('WebScrapeTool', () => {
  const originalFetch = global.fetch;
  const originalLookup = ssrfDeps.lookup;

  beforeEach(() => {
    ssrfDeps.lookup = async (hostname) => {
      if (net.isIP(hostname) !== 0) {
        return [{ address: hostname, family: net.isIP(hostname) === 6 ? 6 : 4 }];
      }
      return [{ address: '93.184.216.34', family: 4 }];
    };
    global.fetch = mock(async () =>
      new Response('Scraped page content', { status: 200 }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    ssrfDeps.lookup = originalLookup;
  });

  test('should have basic properties', () => {
    const tool = new WebScrapeTool();
    expect(tool.name).toBe('web_scrape');
    expect(tool.description).toBeString();
    expect(tool.aliases).toContain('read');
    expect(tool.aliases).toContain('scrape');
    expect(tool.category).toBe('utility');
    expect(tool.permissions).toBe('user');
  });

  test('definition should match OpenAI schema', () => {
    const tool = new WebScrapeTool();
    const def = tool.definition;

    expect(def.type).toBe('function');
    expect(def.function.name).toBe('web_scrape');
    expect(def.function.parameters.type).toBe('object');
    expect(def.function.parameters.required).toContain('url');
    expect(def.function.parameters.properties.url).toBeObject();
    expect(def.function.parameters.properties.query).toBeObject();
    expect(def.function.parameters.properties.prompt).toBeObject();
  });

  test('execute without URL returns error', async () => {
    const tool = new WebScrapeTool();
    const result = await tool.execute({}, createMockCtx());
    expect(result).toBeString();
    expect(result).toContain('URL');
  });

  test('execute with non-HTTP protocol returns error', async () => {
    const tool = new WebScrapeTool();
    const result = await tool.execute({ url: 'ftp://example.com/file' }, createMockCtx());
    expect(result).toBeString();
    expect(result).toContain('HTTP');
  });

  test('execute with valid URL calls fetch and returns content', async () => {
    const tool = new WebScrapeTool();
    const result = await tool.execute({ url: 'https://example.com/article' }, createMockCtx());
    expect(result).toBeString();
    expect(result).toContain('Scraped page content');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/https://example.com/article',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Return-Format': 'markdown',
        }),
      }),
    );
  });

  test('execute rejects credential-bearing URLs before fetching', async () => {
    const fetchMock = mock(async () => new Response('should not be called', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const tool = new WebScrapeTool();
    const result = await tool.execute({ url: 'https://user:pass@example.com/article' }, createMockCtx());

    expect(result).toBe('Error: URL is not allowed.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('execute rejects internal destinations before fetching', async () => {
    const fetchMock = mock(async () => new Response('should not be called', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const tool = new WebScrapeTool();
    const result = await tool.execute({ url: 'http://169.254.169.254/latest/meta-data' }, createMockCtx());

    expect(result).toBe('Error: URL is not allowed.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('execute rejects hosts resolving to private addresses before fetching', async () => {
    ssrfDeps.lookup = async () => [{ address: '10.0.0.1', family: 4 }];
    const fetchMock = mock(async () => new Response('should not be called', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const tool = new WebScrapeTool();
    const result = await tool.execute({ url: 'https://private.example.com/' }, createMockCtx());

    expect(result).toBe('Error: URL is not allowed.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('execute with query includes query in error on fetch failure', async () => {
    global.fetch = mock(async () =>
      new Response('Not Found', { status: 404 }),
    ) as unknown as typeof fetch;

    const tool = new WebScrapeTool();
    const result = await tool.execute(
      { url: 'https://example.com/notfound', query: 'missing page' },
      createMockCtx(),
    );
    expect(result).toBeString();
    expect(result).toContain('HTTP 404');
  });
});
