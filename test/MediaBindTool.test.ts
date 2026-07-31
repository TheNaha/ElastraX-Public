import { afterEach, describe, expect, mock, test, spyOn } from 'bun:test';
import type { MessageContext } from '../src/core/MessageContext';
import { MediaBindTool, mediaConnectFlowProcessor } from '../src/tools/MediaBindTool';
import { MediaService } from '../src/utils/MediaService';
import { FlowHandler } from '../src/core/FlowHandler';

const originalCreateSeerrClient = MediaService.createSeerrClient;
const originalCreateJellyfinClient = MediaService.createJellyfinClient;
const originalBindingService = MediaService.bindingService;
const originalNotificationService = MediaService.notificationService;

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'user-1',
  senderName: 'Alice',
  text: '',
  messageType: 'conversation',
  isGroup: false,
  isBotMentioned: false,
  hasMedia: false,
  mediaReady: Promise.resolve(),
  rawMessage: {},
  language: 'en',
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  resolveRoles: mock(async () => ['user']),
  ...overrides,
});

describe('MediaBindTool', () => {
  afterEach(() => {
    MediaService.createSeerrClient = originalCreateSeerrClient;
    MediaService.createJellyfinClient = originalCreateJellyfinClient;
    MediaService.bindingService = originalBindingService;
    MediaService.notificationService = originalNotificationService;
    FlowHandler.clearSession('user-1', 'media_connect', 'whatsapp');
    FlowHandler.clearSession('media-flow-user', 'media_connect', 'whatsapp');
  });

  test('connect reports when media services are unavailable', async () => {
    MediaService.createSeerrClient = () => ({ isConfigured: false }) as any;
    MediaService.createJellyfinClient = () => ({ isConfigured: false }) as any;

    const result = await new MediaBindTool().execute({ action: 'connect' }, createMockCtx());
    expect(result).toContain('not configured');
  });

  test('connect starts the interactive flow when no binding exists', async () => {
    MediaService.createSeerrClient = () => ({ isConfigured: true }) as any;
    MediaService.createJellyfinClient = () => ({ isConfigured: false }) as any;
    MediaService.bindingService = {
      getBinding: mock(async () => null),
    } as any;

    const spy = spyOn(FlowHandler, 'setSession');
    const result = await new MediaBindTool().execute({ action: 'connect' }, createMockCtx());

    expect(result).toContain('Please enter your username');
    expect(spy).toHaveBeenCalled();
  });

  test('disconnect and notify management use the shared dependency services', async () => {
    MediaService.bindingService = {
      unbind: mock(async (_userId: string, _platform: string, serviceType: string) => serviceType === 'jellyfin'),
      getBindings: mock(async () => []),
    } as any;
    MediaService.notificationService = {
      subscribe: mock(async () => {}),
      unsubscribe: mock(async () => true),
      getSubscriptions: mock(async () => [
        { chatRoomId: 'chat-1', serviceType: 'all', notifyTypes: null },
      ]),
    } as any;

    const tool = new MediaBindTool();
    expect(await tool.execute({ action: 'disconnect' }, createMockCtx())).toContain('unlinked successfully');
    expect(await tool.execute({ action: 'notify', notify_action: 'here' }, createMockCtx())).toContain('now receive media notifications');
    expect(await tool.execute({ action: 'notify', notify_action: 'add', room_id: 'room-2' }, createMockCtx())).toContain('room-2');
    expect(await tool.execute({ action: 'notify', notify_action: 'remove' }, createMockCtx())).toContain('no longer receive');
    expect(await tool.execute({ action: 'notify', notify_action: 'list' }, createMockCtx())).toContain('notification subscriptions');
  });

  test('status reports current bindings and notification rooms', async () => {
    MediaService.bindingService = {
      getBindings: mock(async () => [
        { serviceType: 'jellyfin', externalUsername: 'alice', metadata: '{"isAdmin":true}' },
      ]),
    } as any;
    MediaService.notificationService = {
      getSubscriptions: mock(async () => [
        { chatRoomId: 'chat-1', serviceType: 'all' },
      ]),
    } as any;

    const result = await new MediaBindTool().execute({ action: 'status' }, createMockCtx());
    expect(result).toContain('Linked Accounts');
    expect(result).toContain('Admin');
    expect(result).toContain('chat-1');
  });

  test('registered flow advances from username to password and can complete authentication', async () => {
    const flowUserId = 'media-flow-user';
    const bind = mock(async () => {});
    MediaService.createSeerrClient = () => ({
      isConfigured: true,
      authenticateJellyfin: mock(async () => ({
        id: 77,
        email: 'alice@example.com',
        displayName: 'Alice',
        jellyfinUserId: 'jf-1',
      })),
    }) as any;
    MediaService.createJellyfinClient = () => ({
      isConfigured: true,
      getUserById: mock(async () => ({ Policy: { IsAdministrator: true } })),
    }) as any;
    MediaService.bindingService = {
      getBinding: mock(async () => null),
      bind,
    } as any;

    const usernameCtx = createMockCtx({ senderId: flowUserId, text: 'alice' });
    await mediaConnectFlowProcessor(
      usernameCtx,
      { flow: 'media_connect', step: 'username', data: {}, expiresAt: Date.now() + 120_000 } as any,
      'media_connect',
    );
    expect((usernameCtx.reply as ReturnType<typeof mock>).mock.calls.at(-1)?.[0]).toContain('Now enter your password');

    const passwordCtx = createMockCtx({ senderId: flowUserId, text: 'secret' });
    await mediaConnectFlowProcessor(
      passwordCtx,
      { flow: 'media_connect', step: 'password', data: { username: 'alice' }, expiresAt: Date.now() + 120_000 } as any,
      'media_connect',
    );
    expect(bind).toHaveBeenCalledTimes(2);
    expect((passwordCtx.reply as ReturnType<typeof mock>).mock.calls.at(-1)?.[0]).toContain('Account linked successfully');
  });
});
