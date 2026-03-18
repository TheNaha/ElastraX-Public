import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { MessageContext } from '../src/core/MessageContext';
import { MediaRequestTool, mediaRequestToolDeps } from '../src/tools/MediaRequestTool';

const originalCreateSeerrClient = mediaRequestToolDeps.createSeerrClient;
const originalBindingService = mediaRequestToolDeps.bindingService;

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

describe('MediaRequestTool', () => {
  afterEach(() => {
    mediaRequestToolDeps.createSeerrClient = originalCreateSeerrClient;
    mediaRequestToolDeps.bindingService = originalBindingService;
  });

  test('returns a configuration message when Seerr is unavailable', async () => {
    mediaRequestToolDeps.createSeerrClient = () => ({ isConfigured: false }) as any;

    const result = await new MediaRequestTool().execute({ action: 'request', media_type: 'movie', media_id: 1 }, createMockCtx());
    expect(result).toContain('not configured');
  });

  test('requires a linked account before submitting requests', async () => {
    mediaRequestToolDeps.createSeerrClient = () => ({ isConfigured: true }) as any;
    mediaRequestToolDeps.bindingService = {
      getBinding: mock(async () => null),
    } as any;

    const result = await new MediaRequestTool().execute(
      { action: 'request', media_type: 'movie', media_id: 101 },
      createMockCtx(),
    );

    expect(result).toContain('link your account first');
  });

  test('submits a request for a bound user', async () => {
    const createRequest = mock(async () => ({
      id: 55,
      status: 1,
      type: 'movie',
      media: { tmdbId: 101 },
      requestedBy: { id: 12, displayName: 'Alice' },
      createdAt: '2026-03-18T00:00:00.000Z',
    }));
    mediaRequestToolDeps.createSeerrClient = () => ({
      isConfigured: true,
      createRequest,
    }) as any;
    mediaRequestToolDeps.bindingService = {
      getBinding: mock(async () => ({ externalUserId: '12' })),
    } as any;

    const result = await new MediaRequestTool().execute(
      { action: 'request', media_type: 'movie', media_id: 101 },
      createMockCtx(),
    );

    expect(result).toContain('Request Submitted');
    expect(createRequest).toHaveBeenCalled();
  });

  test('returns request status details', async () => {
    mediaRequestToolDeps.createSeerrClient = () => ({
      isConfigured: true,
      getRequestById: mock(async () => ({
        id: 55,
        status: 2,
        type: 'tv',
        media: { tmdbId: 201 },
        requestedBy: { id: 12, displayName: 'Alice' },
        createdAt: '2026-03-18T00:00:00.000Z',
      })),
    }) as any;

    const result = await new MediaRequestTool().execute({ action: 'status', request_id: 55 }, createMockCtx());
    expect(result).toContain('Request #55');
    expect(result).toContain('Approved');
  });

  test('lists request history and handles empty histories', async () => {
    mediaRequestToolDeps.bindingService = {
      getBinding: mock(async () => ({ externalUserId: '12' })),
    } as any;
    mediaRequestToolDeps.createSeerrClient = () => ({
      isConfigured: true,
      getRequests: mock(async () => ({ results: [] })),
    }) as any;

    const emptyResult = await new MediaRequestTool().execute({ action: 'my-requests' }, createMockCtx());
    expect(emptyResult).toContain('no media requests');

    mediaRequestToolDeps.createSeerrClient = () => ({
      isConfigured: true,
      getRequests: mock(async () => ({
        results: [{
          id: 70,
          status: 1,
          type: 'movie',
          media: { tmdbId: 303 },
        }],
      })),
    }) as any;

    const listResult = await new MediaRequestTool().execute({ action: 'my-requests' }, createMockCtx());
    expect(listResult).toContain('Your Requests');
    expect(listResult).toContain('TMDB:303');
  });
});
