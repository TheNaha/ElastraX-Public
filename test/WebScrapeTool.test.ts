import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageContext } from '../src/core/MessageContext';
import { WebScrapeTool } from '../src/tools/WebScrapeTool';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

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

  beforeEach(() => {
    global.fetch = mock(async () =>
      new Response('Scraped page content', { status: 200 }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
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
