import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { JellyfinClient } from '../src/providers/jellyfin/JellyfinClient';

describe('JellyfinClient', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('isConfigured reflects missing or present credentials', () => {
    expect(new JellyfinClient('', '').isConfigured).toBe(false);
    expect(new JellyfinClient('https://jf.example', 'token').isConfigured).toBe(true);
  });

  test('authenticateUser posts credentials to Jellyfin', async () => {
    global.fetch = mock(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.body).toContain('"Username":"alice"');
      expect(init?.body).toContain('"Pw":"secret"');
      return {
        ok: true,
        json: async () => ({
          User: {
            Id: 'user-1',
            Name: 'alice',
            Policy: { IsAdministrator: true, IsDisabled: false },
          },
          AccessToken: 'token-123',
          ServerId: 'server-1',
        }),
      } as Response;
    }) as any;

    const client = new JellyfinClient('https://jf.example', 'api-key');
    const result = await client.authenticateUser('alice', 'secret');

    expect(result.User.Name).toBe('alice');
    expect(result.AccessToken).toBe('token-123');
  });

  test('searchItems builds the expected query string', async () => {
    global.fetch = mock(async (url: string) => {
      expect(url).toContain('/Items?');
      expect(url).toContain('searchTerm=matrix');
      expect(url).toContain('userId=user-1');
      expect(url).toContain('IncludeItemTypes=Movie%2CSeries');
      return {
        ok: true,
        json: async () => ({
          Items: [{ Id: 'item-1', Name: 'The Matrix', Type: 'Movie' }],
          TotalRecordCount: 1,
        }),
      } as Response;
    }) as any;

    const client = new JellyfinClient('https://jf.example', 'api-key');
    const result = await client.searchItems('matrix', {
      userId: 'user-1',
      limit: 5,
      includeTypes: ['Movie', 'Series'],
    });

    expect(result.Items[0].Name).toBe('The Matrix');
  });

  test('getWatchLink prefers the external URL when it exists', () => {
    const client = new JellyfinClient('https://internal.example', 'api-key', 'https://watch.example');
    expect(client.getWatchLink('item-99')).toBe('https://watch.example/web/index.html#!/details?id=item-99');
  });

  test('throws a useful error message when Jellyfin returns a failure', async () => {
    global.fetch = mock(async () => ({
      ok: false,
      status: 403,
      text: async () => 'denied',
    })) as any;

    const client = new JellyfinClient('https://jf.example', 'api-key');

    await expect(client.getSystemInfo()).rejects.toThrow('Jellyfin API GET /System/Info failed: 403 denied');
  });
});
