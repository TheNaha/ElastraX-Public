import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { WebSearchTool } from '../src/tools/WebSearchTool';
import { MessageContext } from '../src/core/MessageContext';

const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

const createMockCtx = (): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'user-1',
  senderName: 'Alice',
  text: '',
  isGroup: false,
  isBotMentioned: false,
  hasMedia: false,
  rawMessage: {},
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  messageId: 'msg-1',
  mediaReady: Promise.resolve(),
});

describe('WebSearchTool – execute (fetch path)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should return formatted results on a successful search', async () => {
    const tool = new WebSearchTool();

    global.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: 'Result 1', url: 'https://example.com/1', content: 'Excerpt one' },
            { title: 'Result 2', url: 'https://example.com/2', content: 'Excerpt two' },
          ],
        }),
        { status: 200 },
      )
    ) as any;

    const result = await tool.execute({ query: 'bun test' }, createMockCtx());
    expect(result).toContain('Search results for "bun test"');
    expect(result).toContain('Result 1');
    expect(result).toContain('https://example.com/1');
    expect(result).toContain('Excerpt one');
  });

  test('should return "No results found" when results array is empty', async () => {
    const tool = new WebSearchTool();

    global.fetch = mock(async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 })
    ) as any;

    const result = await tool.execute({ query: 'empty query' }, createMockCtx());
    expect(result).toContain('No results found');
    expect(result).toContain('empty query');
  });

  test('should return "No results found" when results property is absent', async () => {
    const tool = new WebSearchTool();

    global.fetch = mock(async () =>
      new Response(JSON.stringify({}), { status: 200 })
    ) as any;

    const result = await tool.execute({ query: 'no data' }, createMockCtx());
    expect(result).toContain('No results found');
  });

  test('should return failure message on non-OK HTTP response', async () => {
    const tool = new WebSearchTool();

    global.fetch = mock(async () =>
      new Response('Bad Gateway', { status: 502 })
    ) as any;

    const result = await tool.execute({ query: 'failing query' }, createMockCtx());
    expect(result).toContain('Failed to search the web');
  });

  test('should return failure message on network/fetch error', async () => {
    const tool = new WebSearchTool();

    global.fetch = mock(async () => {
      throw new Error('Network error');
    }) as any;

    const result = await tool.execute({ query: 'network broken' }, createMockCtx());
    expect(result).toContain('Failed to search the web');
  });

  test('should format up to 5 results from the response', async () => {
    const tool = new WebSearchTool();
    const manyResults = Array.from({ length: 10 }, (_, i) => ({
      title: `Result ${i + 1}`,
      url: `https://example.com/${i + 1}`,
      content: `Excerpt ${i + 1}`,
    }));

    global.fetch = mock(async () =>
      new Response(JSON.stringify({ results: manyResults }), { status: 200 })
    ) as any;

    const result = await tool.execute({ query: 'many results' }, createMockCtx());
    // Only top 5 should appear
    expect(result).toContain('[1]');
    expect(result).toContain('[5]');
    expect(result).not.toContain('[6]');
  });

  test('should use SEARXNG_URL env var if set', async () => {
    const originalEnv = process.env.SEARXNG_URL;
    process.env.SEARXNG_URL = 'https://custom.searxng.local';

    const tool = new WebSearchTool();
    let capturedUrl = '';

    global.fetch = mock(async (url: any) => {
      capturedUrl = url as string;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as any;

    await tool.execute({ query: 'custom instance' }, createMockCtx());
    expect(capturedUrl).toContain('custom.searxng.local');

    process.env.SEARXNG_URL = originalEnv;
  });

  test('should handle snippet field instead of content', async () => {
    const tool = new WebSearchTool();

    global.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          results: [{ title: 'Snippet Result', url: 'https://example.com', snippet: 'A snippet' }],
        }),
        { status: 200 },
      )
    ) as any;

    const result = await tool.execute({ query: 'snippet test' }, createMockCtx());
    expect(result).toContain('Snippet Result');
  });
});
