import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { AIClient } from '../src/ai/client';

type ClientInternals = {
  baseUrl: string;
  apiKey: string;
  modelName: string;
};

function getClientInternals(client: AIClient): ClientInternals {
  return client as unknown as ClientInternals;
}

function assignFetch(
  handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  global.fetch = mock(handler) as unknown as typeof global.fetch;
}

const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

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
    expect(getClientInternals(client).modelName).toContain('Llama');
  });

  test('should use "" as default apiKey when none provided', () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1' });
    expect(getClientInternals(client).apiKey).toBe('');
  });

  test('chatCompletion should not add tools to payload when tools array is empty', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'test' });

    let capturedBody: Record<string, unknown> | undefined;
    assignFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { total_tokens: 5 },
      }), { status: 200 });
    });

    await client.chatCompletion([{ role: 'user', content: 'hello' }], []);
    expect(capturedBody.tools).toBeUndefined();
    expect(capturedBody.tool_choice).toBeUndefined();
  });

  test('chatCompletion should include tools in payload when tools are provided', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'test' });

    const fakeTool = {
      type: 'function' as const,
      function: {
        name: 'noop',
        description: 'Does nothing',
        parameters: { type: 'object' as const, properties: {}, required: [] },
      },
    };

    let capturedBody: Record<string, unknown> | undefined;
    assignFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '' } }],
        usage: { total_tokens: 3 },
      }), { status: 200 });
    });

    await client.chatCompletion([{ role: 'user', content: 'hi' }], [fakeTool]);
    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.tool_choice).toBe('auto');
  });

  test('chatCompletion should not duplicate /chat/completions suffix when already in baseUrl', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1/chat/completions', apiKey: 'test' });

    let capturedUrl = '';
    assignFetch(async (url) => {
      capturedUrl = url as string;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { total_tokens: 1 },
      }), { status: 200 });
    });

    await client.chatCompletion([{ role: 'user', content: 'hi' }]);
    expect(capturedUrl).toBe('https://api.example.com/v1/chat/completions');
  });

  test('chatCompletion should strip trailing slash before appending path', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1/', apiKey: 'test' });

    let capturedUrl = '';
    assignFetch(async (url) => {
      capturedUrl = url as string;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { total_tokens: 1 },
      }), { status: 200 });
    });

    await client.chatCompletion([{ role: 'user', content: 'hi' }]);
    expect(capturedUrl).toBe('https://api.example.com/v1/chat/completions');
  });

  test('chatCompletion should throw when response is not ok', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'test' });

    assignFetch(async () => {
      return new Response('Unauthorized', { status: 401 });
    });

    await expect(client.chatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'LLM API returned 401'
    );
  });

  test('chatCompletion should return fallback message when choices is empty', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'test' });

    assignFetch(async () => {
      return new Response(JSON.stringify({ choices: [], usage: {} }), { status: 200 });
    });

    const result = await client.chatCompletion([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('No response generated.');
  });

  test('chatCompletion should send Authorization header with Bearer token', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'my-secret' });

    let capturedHeaders: HeadersInit | undefined;
    assignFetch(async (_url, init) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: {},
      }), { status: 200 });
    });

    await client.chatCompletion([{ role: 'user', content: 'hi' }]);
    expect((capturedHeaders as Record<string, string>)['Authorization']).toBe('Bearer my-secret');
  });

  test('chatCompletion should throw when apiKey is missing', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: '' });
    await expect(client.chatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'AI_API_KEY is missing or empty. A valid API key is required.',
    );
  });

  test('chatCompletionStream should parse data chunks and stop on DONE', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'test' });

    assignFetch(async () => new Response(
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}\n\n' +
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n' +
      'data: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ));

    const chunks = [];
    for await (const chunk of client.chatCompletionStream([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0]?.delta?.content).toBe('hel');
    expect(chunks[1].choices[0]?.delta?.content).toBe('lo');
  });

  test('chatCompletionStream ignores malformed and comment SSE lines', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'test' });

    assignFetch(async () => new Response(
      ': keepalive\n\n' +
      'data: not-json\n\n' +
      'event: ping\n\n' +
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
      'data: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ));

    const chunks = [];
    for await (const chunk of client.chatCompletionStream([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0]?.delta?.content).toBe('ok');
  });

  test('chatCompletionStream throws on non-OK responses', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'test' });
    assignFetch(async () => new Response('bad gateway', { status: 502 }));

    const iterator = client.chatCompletionStream([{ role: 'user', content: 'hi' }]);
    await expect(iterator.next()).rejects.toThrow('LLM API returned 502: bad gateway');
  });

  test('chatCompletionStream throws when response body is null', async () => {
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'test' });
    assignFetch(async () => new Response(null, { status: 200 }));

    const iterator = client.chatCompletionStream([{ role: 'user', content: 'hi' }]);
    await expect(iterator.next()).rejects.toThrow('Response body is null');
  });
});
