import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { AIClient } from '../src/ai/client';

mock.module('../src/utils/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

describe('AIClient – edge cases', () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AI_API_BASE_URL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL_NAME;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  test('should use default model name when none is provided', () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1' });
    expect((client as any).modelName).toContain('Llama');
  });

  test('should use "dummy" as default apiKey when none provided', () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1' });
    expect((client as any).apiKey).toBe('dummy');
  });

  test('chatCompletion should not add tools to payload when tools array is empty', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1' });

    let capturedBody: any;
    global.fetch = mock(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { total_tokens: 5 },
      }), { status: 200 });
    }) as any;

    await client.chatCompletion([{ role: 'user', content: 'hello' }], []);
    expect(capturedBody.tools).toBeUndefined();
    expect(capturedBody.tool_choice).toBeUndefined();
  });

  test('chatCompletion should include tools in payload when tools are provided', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1' });

    const fakeTool = {
      type: 'function' as const,
      function: {
        name: 'noop',
        description: 'Does nothing',
        parameters: { type: 'object' as const, properties: {}, required: [] },
      },
    };

    let capturedBody: any;
    global.fetch = mock(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '' } }],
        usage: { total_tokens: 3 },
      }), { status: 200 });
    }) as any;

    await client.chatCompletion([{ role: 'user', content: 'hi' }], [fakeTool]);
    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.tool_choice).toBe('auto');
  });

  test('chatCompletion should not duplicate /chat/completions suffix when already in baseUrl', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1/chat/completions' });

    let capturedUrl = '';
    global.fetch = mock(async (url: any) => {
      capturedUrl = url as string;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { total_tokens: 1 },
      }), { status: 200 });
    }) as any;

    await client.chatCompletion([{ role: 'user', content: 'hi' }]);
    expect(capturedUrl).toBe('https://api.example.com/v1/chat/completions');
  });

  test('chatCompletion should strip trailing slash before appending path', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1/' });

    let capturedUrl = '';
    global.fetch = mock(async (url: any) => {
      capturedUrl = url as string;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { total_tokens: 1 },
      }), { status: 200 });
    }) as any;

    await client.chatCompletion([{ role: 'user', content: 'hi' }]);
    expect(capturedUrl).toBe('https://api.example.com/v1/chat/completions');
  });

  test('chatCompletion should throw when response is not ok', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1' });

    global.fetch = mock(async () => {
      return new Response('Unauthorized', { status: 401 });
    }) as any;

    await expect(client.chatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'LLM API returned 401'
    );
  });

  test('chatCompletion should return fallback message when choices is empty', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1' });

    global.fetch = mock(async () => {
      return new Response(JSON.stringify({ choices: [], usage: {} }), { status: 200 });
    }) as any;

    const result = await client.chatCompletion([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('No response generated.');
  });

  test('chatCompletion should send Authorization header with Bearer token', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'my-secret' });

    let capturedHeaders: any;
    global.fetch = mock(async (_url: any, init: any) => {
      capturedHeaders = init.headers;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: {},
      }), { status: 200 });
    }) as any;

    await client.chatCompletion([{ role: 'user', content: 'hi' }]);
    expect(capturedHeaders['Authorization']).toBe('Bearer my-secret');
  });
});
