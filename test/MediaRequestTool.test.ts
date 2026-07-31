import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { MessageContext } from '../src/core/MessageContext';
import { MediaRequestTool } from '../src/tools/MediaRequestTool';
import { MediaService } from '../src/utils/MediaService';

const originalCreateSeerrClient = MediaService.createSeerrClient;
const originalBindingService = MediaService.bindingService;

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
    MediaService.createSeerrClient = originalCreateSeerrClient;
    MediaService.bindingService = originalBindingService;
  });

  test('returns a configuration message when Seerr is unavailable', async () => {
    MediaService.createSeerrClient = () => ({ isConfigured: false }) as any;

    const result = await new MediaRequestTool().execute({ action: 'request', media_type: 'movie', media_id: 1 }, createMockCtx());
    expect(result).toContain('not configured');
  });

  test('requires a linked account before submitting requests', async () => {
    MediaService.createSeerrClient = () => ({ isConfigured: true }) as any;
    MediaService.bindingService = {
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
    MediaService.createSeerrClient = () => ({
      isConfigured: true,
      createRequest,
    }) as any;
    MediaService.bindingService = {
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
    MediaService.createSeerrClient = () => ({
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
    MediaService.bindingService = {
      getBinding: mock(async () => ({ externalUserId: '12' })),
    } as any;
    MediaService.createSeerrClient = () => ({
      isConfigured: true,
      getRequests: mock(async () => ({ results: [] })),
    }) as any;

    const emptyResult = await new MediaRequestTool().execute({ action: 'my-requests' }, createMockCtx());
    expect(emptyResult).toContain('no media requests');

    MediaService.createSeerrClient = () => ({
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
