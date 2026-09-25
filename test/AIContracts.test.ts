import { afterEach, describe, expect, mock, test } from 'bun:test';
import { AIClient, StreamingToolCallAccumulator } from '../src/ai/client';
import { AIProtocolError } from '../src/ai/errors';
import { SSEDecoder } from '../src/ai/sse';

function assignFetch(
  handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  global.fetch = mock(handler) as unknown as typeof global.fetch;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe('AI response contracts', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('returns a canonical non-streaming envelope', async () => {
    assignFetch(async () => new Response(JSON.stringify({
      id: 'completion-1',
      model: 'served-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'done' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }), { status: 200, headers: { 'x-request-id': 'request-42' } }));

    const client = new AIClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'key',
      modelName: 'requested-model',
    });
    const envelope = await client.chatCompletionEnvelope([{ role: 'user', content: 'hi' }]);

    expect(envelope.requestId).toBe('request-42');
    expect(envelope.model).toBe('served-model');
    expect(envelope.finishReason).toBe('stop');
    expect(envelope.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    expect(envelope.message.content).toBe('done');
  });

  test('adapts the output-token request field', async () => {
    let body: Record<string, unknown> = {};
    assignFetch(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }), { status: 200 });
    });

    const client = new AIClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'key',
      maxTokensParam: 'max_completion_tokens',
    });
    await client.chatCompletion([{ role: 'user', content: 'hi' }], undefined, 0.2, 123);

    expect(body.max_completion_tokens).toBe(123);
    expect(body.max_tokens).toBeUndefined();
  });

  test('parses mixed line endings, multiline data, final buffers, finish, and usage', async () => {
    const first = [
      ': keepalive',
      'data:{"id":"stream-1","object":"chat.completion.chunk","created":1,"model":"m",',
      'data: "choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}',
      '',
      '',
    ].join('\r\n');
    const second = [
      'data: {"id":"stream-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      '',
      '',
    ].join('\r');
    const usage = [
      'data: {"id":"stream-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
    ].join('\n');

    assignFetch(async () => new Response(first + second + usage, { status: 200 }));
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'key' });
    const chunks = await collect(client.chatCompletionStream([{ role: 'user', content: 'hi' }]));

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.choices[0]?.delta.content).toBe('hel');
    expect(chunks[1]?.choices[0]?.delta.content).toBe('lo');
    expect(chunks[1]?.choices[0]?.finish_reason).toBe('stop');
    expect(chunks[2]?.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  test('preserves streaming tool-call fragments for accumulation', async () => {
    assignFetch(async () => new Response([
      'data: {"id":"s","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]},"finish_reason":null}]}',
      '',
      'data: {"id":"s","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"wifi\\"}"}}]},"finish_reason":null}]}',
      '',
      'data: {"id":"s","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200 }));

    const client = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'key' });
    const chunks = await collect(client.chatCompletionStream([{ role: 'user', content: 'hi' }]));
    const accumulator = new StreamingToolCallAccumulator();
    for (const chunk of chunks) accumulator.consumeDelta(chunk.choices[0]?.delta.tool_calls);
    expect(accumulator.finish()[0]?.function.arguments).toBe('{"q":"wifi"}');
  });

  test('rejects an empty stream', async () => {
    assignFetch(async () => new Response(': keepalive\n\n', { status: 200 }));
    const client = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'key' });
    const error = await client.chatCompletionStream([{ role: 'user', content: 'hi' }])
      .next()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AIProtocolError);
    expect((error as AIProtocolError).code).toBe('empty_stream');
  });
});

describe('SSE decoder', () => {
  test('handles a CRLF pair split across chunks and CR-only events', () => {
    const decoder = new SSEDecoder();
    expect(decoder.push('data: one\r')).toEqual([]);
    const events = decoder.push('\rdata: two\r\r');
    expect([...events, ...decoder.finish()]).toEqual([{ data: 'one' }, { data: 'two' }]);
  });

  test('dispatches a final unterminated data buffer', () => {
    const decoder = new SSEDecoder();
    expect(decoder.push('data: final')).toEqual([]);
    expect(decoder.finish()).toEqual([{ data: 'final' }]);
  });

  test('enforces buffer and event bounds', () => {
    expect(() => new SSEDecoder({ maxBufferBytes: 8 }).push('data: too-long')).toThrow(AIProtocolError);
    expect(() => new SSEDecoder({ maxEventBytes: 8 }).push('data:1234\n')).toThrow(AIProtocolError);
  });
});

describe('streaming tool-call fragments', () => {
  test('merges argument fragments without duplicating call ids', () => {
    const accumulator = new StreamingToolCallAccumulator();
    accumulator.consume({
      index: 0,
      id: 'call-1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"q":' },
    });
    accumulator.consume({
      index: 0,
      function: { arguments: '"wifi"}' },
    });

    expect(accumulator.finish()).toEqual([{
      index: 0,
      id: 'call-1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"q":"wifi"}' },
    }]);
  });
});
