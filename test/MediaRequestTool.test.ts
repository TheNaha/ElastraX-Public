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
}) as unknown as MessageContext;

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

  test('returns request status details for the bound owner', async () => {
    MediaService.bindingService = {
      getBinding: mock(async () => ({ externalUserId: '12', platform: 'discord' })),
    } as any;
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

  test('refuses to show a request owned by a different Seerr user', async () => {
    const getRequestById = mock(async () => ({
      id: 55,
      status: 2,
      type: 'tv',
      media: { tmdbId: 201 },
      requestedBy: { id: 99, displayName: 'Someone Else' },
      createdAt: '2026-03-18T00:00:00.000Z',
    }));
    MediaService.bindingService = {
      getBinding: mock(async () => ({ externalUserId: '12', platform: 'discord' })),
    } as any;
    MediaService.createSeerrClient = () => ({ isConfigured: true, getRequestById }) as any;

    const result = await new MediaRequestTool().execute({ action: 'status', request_id: 55 }, createMockCtx());
    expect(result).toContain('only view your own media requests');
    expect(result).not.toContain('Someone Else');
  });

  test('refuses to show a request when the Seerr user id is missing', async () => {
    const getRequestById = mock(async () => ({
      id: 55,
      status: 2,
      type: 'tv',
      media: { tmdbId: 201 },
      requestedBy: { id: 12, displayName: 'Alice' },
      createdAt: '2026-03-18T00:00:00.000Z',
    }));
    MediaService.bindingService = {
      getBinding: mock(async () => ({ id: 7, externalUserId: 'not-a-number', platform: 'discord' })),
    } as any;
    MediaService.createSeerrClient = () => ({ isConfigured: true, getRequestById }) as any;

    const result = await new MediaRequestTool().execute({ action: 'status', request_id: 55 }, createMockCtx());
    expect(result).toContain('link your account first');
    expect(getRequestById).not.toHaveBeenCalled();
  });

  test('refuses to use a binding created on a different platform', async () => {
    const getRequestById = mock(async () => ({
      id: 55,
      status: 2,
      type: 'tv',
      media: { tmdbId: 201 },
      requestedBy: { id: 12, displayName: 'Alice' },
      createdAt: '2026-03-18T00:00:00.000Z',
    }));
    MediaService.bindingService = {
      getBinding: mock(async () => ({ externalUserId: '12', platform: 'whatsapp' })),
    } as any;
    MediaService.createSeerrClient = () => ({ isConfigured: true, getRequestById }) as any;

    const result = await new MediaRequestTool().execute({ action: 'status', request_id: 55 }, createMockCtx());
    expect(result).toContain('link your account first');
    expect(getRequestById).not.toHaveBeenCalled();
  });

  test('refuses to use an unverified binding', async () => {
    const createRequest = mock(async () => ({ id: 1 }));
    MediaService.bindingService = {
      getBinding: mock(async () => ({ externalUserId: '12', platform: 'discord', metadata: '{"verified":false}' })),
    } as any;
    MediaService.createSeerrClient = () => ({ isConfigured: true, createRequest }) as any;

    const result = await new MediaRequestTool().execute(
      { action: 'request', media_type: 'movie', media_id: 101 },
      createMockCtx(),
    );
    expect(result).toContain('link your account first');
    expect(createRequest).not.toHaveBeenCalled();
  });

  test('lists request history and handles empty histories', async () => {
    MediaService.bindingService = {
      getBinding: mock(async () => ({ externalUserId: '12', platform: 'discord' })),
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
