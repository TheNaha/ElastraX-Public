import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { MessageContext } from '../src/core/MessageContext';
import { MediaBindTool, mediaBindToolDeps, mediaConnectFlowProcessor } from '../src/tools/MediaBindTool';
import { FlowHandler } from '../src/core/FlowHandler';

const originalCreateSeerrClient = mediaBindToolDeps.createSeerrClient;
const originalCreateJellyfinClient = mediaBindToolDeps.createJellyfinClient;
const originalBindingService = mediaBindToolDeps.bindingService;
const originalNotificationService = mediaBindToolDeps.notificationService;

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
    mediaBindToolDeps.createSeerrClient = originalCreateSeerrClient;
    mediaBindToolDeps.createJellyfinClient = originalCreateJellyfinClient;
    mediaBindToolDeps.bindingService = originalBindingService;
    mediaBindToolDeps.notificationService = originalNotificationService;
    FlowHandler.clearSession('user-1', 'media_connect', 'whatsapp');
    FlowHandler.clearSession('media-flow-user', 'media_connect', 'whatsapp');
  });

  test('connect reports when media services are unavailable', async () => {
    mediaBindToolDeps.createSeerrClient = () => ({ isConfigured: false }) as any;
    mediaBindToolDeps.createJellyfinClient = () => ({ isConfigured: false }) as any;

    const result = await new MediaBindTool().execute({ action: 'connect' }, createMockCtx());
    expect(result).toContain('not configured');
  });

  test('connect starts the interactive flow when no binding exists', async () => {
    mediaBindToolDeps.createSeerrClient = () => ({ isConfigured: true }) as any;
    mediaBindToolDeps.createJellyfinClient = () => ({ isConfigured: false }) as any;
    mediaBindToolDeps.bindingService = {
      getBinding: mock(async () => null),
    } as any;

    const result = await new MediaBindTool().execute({ action: 'connect' }, createMockCtx());
    const activeFlow = FlowHandler.getActiveFlow('user-1', 'whatsapp');

    expect(result).toContain('Please enter your username');
    expect(activeFlow?.flow.step).toBe('username');
  });

  test('disconnect and notify management use the shared dependency services', async () => {
    mediaBindToolDeps.bindingService = {
      unbind: mock(async (_userId: string, _platform: string, serviceType: string) => serviceType === 'jellyfin'),
      getBindings: mock(async () => []),
    } as any;
    mediaBindToolDeps.notificationService = {
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
    mediaBindToolDeps.bindingService = {
      getBindings: mock(async () => [
        { serviceType: 'jellyfin', externalUsername: 'alice', metadata: '{"isAdmin":true}' },
      ]),
    } as any;
    mediaBindToolDeps.notificationService = {
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
    mediaBindToolDeps.createSeerrClient = () => ({
      isConfigured: true,
      authenticateJellyfin: mock(async () => ({
        id: 77,
        email: 'alice@example.com',
        displayName: 'Alice',
        jellyfinUserId: 'jf-1',
      })),
    }) as any;
    mediaBindToolDeps.createJellyfinClient = () => ({
      isConfigured: true,
      getUserById: mock(async () => ({ Policy: { IsAdministrator: true } })),
    }) as any;
    mediaBindToolDeps.bindingService = {
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
