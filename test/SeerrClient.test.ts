import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { SeerrClient } from '../src/providers/seerr/SeerrClient';

describe('SeerrClient', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('isConfigured reflects missing or present credentials', () => {
    expect(new SeerrClient('', '').isConfigured).toBe(false);
    expect(new SeerrClient('https://seerr.example/api/v1', 'token').isConfigured).toBe(true);
  });

  test('search issues a GET request and returns parsed results', async () => {
    global.fetch = mock(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/search?query=dark&page=2');
      expect(init?.method).toBe('GET');
      return {
        ok: true,
        json: async () => ({
          page: 2,
          totalPages: 5,
          totalResults: 1,
          results: [{ id: 10, mediaType: 'movie', title: 'Dark City' }],
        }),
      } as Response;
    }) as any;

    const client = new SeerrClient('https://seerr.example/api/v1', 'token');
    const result = await client.search('dark', 2);

    expect(result.results[0].title).toBe('Dark City');
    expect(result.page).toBe(2);
  });

  test('createRequest posts the request payload', async () => {
    global.fetch = mock(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.body).toContain('"mediaType":"tv"');
      expect(init?.body).toContain('"mediaId":42');
      expect(init?.body).toContain('"seasons":[1,2]');
      expect(init?.body).toContain('"userId":99');
      return {
        ok: true,
        json: async () => ({
          id: 77,
          status: 1,
          type: 'tv',
          media: { id: 1, tmdbId: 42, status: 2, mediaType: 'tv' },
          requestedBy: { id: 99, displayName: 'Alice' },
          createdAt: '2026-03-18T00:00:00.000Z',
          updatedAt: '2026-03-18T00:00:00.000Z',
        }),
      } as Response;
    }) as any;

    const client = new SeerrClient('https://seerr.example/api/v1', 'token');
    const result = await client.createRequest('tv', 42, { seasons: [1, 2], userId: 99 });

    expect(result.id).toBe(77);
    expect(result.requestedBy.displayName).toBe('Alice');
  });

  test('getStatus returns parsed status payloads', async () => {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => ({
        version: '1.0.0',
        commitTag: 'abc123',
        updateAvailable: false,
        commitsBehind: 0,
      }),
    })) as any;

    const client = new SeerrClient('https://seerr.example/api/v1', 'token');
    const result = await client.getStatus();

    expect(result.version).toBe('1.0.0');
  });

  test('throws a useful error message when the API returns a failure', async () => {
    global.fetch = mock(async () => ({
      ok: false,
      status: 500,
      text: async () => 'server exploded',
    })) as any;

    const client = new SeerrClient('https://seerr.example/api/v1', 'token');

    await expect(client.getStatus()).rejects.toThrow('Seerr API GET /status failed: 500 server exploded');
  });
});
