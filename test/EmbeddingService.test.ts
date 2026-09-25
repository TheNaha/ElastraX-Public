import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createEmbeddingSpaceId,
  EmbeddingService,
  parseEmbeddingSpaceId,
} from '../src/utils/EmbeddingService';

const ENV_KEYS = [
  'EMBEDDING_API_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_MODEL',
  'EMBEDDING_TIMEOUT_MS',
  'EMBEDDING_DIMENSION',
] as const;

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('EmbeddingService', () => {
  const originalFetch = global.fetch;
  const originalEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));

  beforeEach(() => {
    EmbeddingService.clearCache();
    process.env.EMBEDDING_API_URL = 'https://embed.example.com/v1';
    process.env.EMBEDDING_API_KEY = 'key';
    process.env.EMBEDDING_MODEL = 'embed-model';
    delete process.env.EMBEDDING_TIMEOUT_MS;
    delete process.env.EMBEDDING_DIMENSION;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    EmbeddingService.clearCache();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('uses response indices to restore input order', async () => {
    global.fetch = mock(async () => response([
      { index: 1, embedding: [2, 2] },
      { index: 0, embedding: [1, 1] },
    ])) as unknown as typeof fetch;

    const vectors = await EmbeddingService.embed(['first', 'second']);
    expect(Array.from(vectors[0]!)).toEqual([1, 1]);
    expect(Array.from(vectors[1]!)).toEqual([2, 2]);
  });

  test('rejects duplicate, missing, and out-of-range indices', async () => {
    global.fetch = mock(async () => response([
      { index: 0, embedding: [1] },
      { index: 0, embedding: [1] },
    ])) as unknown as typeof fetch;
    await expect(EmbeddingService.embed(['a', 'b'])).rejects.toThrow('duplicate response index');

    global.fetch = mock(async () => response([{ index: 2, embedding: [1] }])) as unknown as typeof fetch;
    await expect(EmbeddingService.embed(['a'])).rejects.toThrow('invalid response index');
  });

  test('rejects inconsistent dimensions within a response', async () => {
    global.fetch = mock(async () => response([
      { index: 0, embedding: [1, 2] },
      { index: 1, embedding: [1] },
    ])) as unknown as typeof fetch;

    await expect(EmbeddingService.embed(['a', 'b'])).rejects.toThrow('dimension mismatch');
  });

  test('validates a configured expected dimension', async () => {
    process.env.EMBEDDING_DIMENSION = '3';
    global.fetch = mock(async () => response([
      { index: 0, embedding: [1, 2] },
    ])) as unknown as typeof fetch;

    await expect(EmbeddingService.embed(['a'])).rejects.toThrow('expected 3, received 2');
  });

  test('coalesces identical concurrent requests into one fetch', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchMock = mock(async () => {
      await gate;
      return response([{ index: 0, embedding: [1, 0] }]);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const first = EmbeddingService.embed(['same query']);
    const second = EmbeddingService.embed(['same query']);
    release?.();
    const [firstVectors, secondVectors] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Array.from(firstVectors[0]!)).toEqual([1, 0]);
    expect(Array.from(secondVectors[0]!)).toEqual([1, 0]);
  });

  test('encodes model, endpoint, and dimension into a parseable space id', () => {
    const first = createEmbeddingSpaceId('model-a', 'https://one.example/v1', 3);
    expect(parseEmbeddingSpaceId(first)).toMatchObject({ model: 'model-a', dimension: 3 });
    expect(createEmbeddingSpaceId('model-a', 'https://two.example/v1', 3)).not.toBe(first);
    expect(createEmbeddingSpaceId('model-a', 'https://one.example/v1', 4)).not.toBe(first);
    expect(createEmbeddingSpaceId('model-b', 'https://one.example/v1', 3)).not.toBe(first);
  });
});
