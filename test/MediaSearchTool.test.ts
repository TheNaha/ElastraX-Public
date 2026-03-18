import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { MessageContext } from '../src/core/MessageContext';
import { MediaSearchTool, mediaSearchToolDeps } from '../src/tools/MediaSearchTool';

const originalCreateSeerrClient = mediaSearchToolDeps.createSeerrClient;

const createMockCtx = (): MessageContext => ({
  platform: 'discord',
  chatId: 'room-1',
  senderId: 'user-1',
  senderName: 'Alice',
  text: '',
  messageType: 'conversation',
  isGroup: false,
  isBotMentioned: false,
  hasMedia: false,
  mediaReady: Promise.resolve(),
  rawMessage: {},
  reply: mock(async () => {}),
  checkPermissions: mock(async () => true),
  resolveRoles: mock(async () => ['user']),
});

describe('MediaSearchTool', () => {
  afterEach(() => {
    mediaSearchToolDeps.createSeerrClient = originalCreateSeerrClient;
  });

  test('returns a configuration message when Seerr is unavailable', async () => {
    mediaSearchToolDeps.createSeerrClient = () => ({ isConfigured: false }) as any;

    const result = await new MediaSearchTool().execute({ action: 'search', query: 'dark' }, createMockCtx());
    expect(result).toContain('not configured');
  });

  test('search returns formatted results and filters out people', async () => {
    mediaSearchToolDeps.createSeerrClient = () => ({
      isConfigured: true,
      search: mock(async () => ({
        page: 1,
        totalPages: 1,
        totalResults: 2,
        results: [
          { id: 10, mediaType: 'movie', title: 'Dark City', voteAverage: 7.1, mediaInfo: { status: 5 } },
          { id: 11, mediaType: 'person', name: 'Actor Person' },
        ],
      })),
    }) as any;

    const result = await new MediaSearchTool().execute({ action: 'search', query: 'dark' }, createMockCtx());

    expect(result).toContain('Dark City');
    expect(result).not.toContain('Actor Person');
  });

  test('search reports when filtering removes all results', async () => {
    mediaSearchToolDeps.createSeerrClient = () => ({
      isConfigured: true,
      search: mock(async () => ({
        page: 1,
        totalPages: 1,
        totalResults: 1,
        results: [{ id: 12, mediaType: 'movie', title: 'Movie Only' }],
      })),
    }) as any;

    const result = await new MediaSearchTool().execute(
      { action: 'search', query: 'movie', media_type: 'tv' },
      createMockCtx(),
    );

    expect(result).toContain('No tv results found');
  });

  test('returns a friendly error when discovery calls fail', async () => {
    mediaSearchToolDeps.createSeerrClient = () => ({
      isConfigured: true,
      getTrending: mock(async () => {
        throw new Error('service unavailable');
      }),
    }) as any;

    const result = await new MediaSearchTool().execute({ action: 'trending' }, createMockCtx());
    expect(result).toContain('Search failed: service unavailable');
  });
});
