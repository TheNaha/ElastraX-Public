import { describe, expect, mock, spyOn, test } from 'bun:test';
import { withEnvironment } from './helpers/env';

const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};

mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

import { WebhookServer } from '../src/webhookServer';
import { ServiceBindingService } from '../src/utils/ServiceBindingService';
import { NotificationSubscriptionService } from '../src/utils/NotificationSubscriptionService';

const SEERR_SECRET = 'seerr-webhook-secret-0123456789abcdef';
const JELLYFIN_SECRET = 'jellyfin-webhook-secret-0123456789';

function portOf(server: WebhookServer): number {
  const port = (server as unknown as { server?: { port?: number } }).server?.port;
  if (typeof port !== 'number') throw new Error('Webhook server did not start');
  return port;
}

async function withMediaServer(
  overrides: Record<string, string | undefined>,
  callback: (baseUrl: string) => Promise<void>,
  register?: (server: WebhookServer) => void,
): Promise<void> {
  await withEnvironment({
    WEBHOOK_ENABLED: 'true',
    WEBHOOK_HOST: '127.0.0.1',
    WEBHOOK_PORT: '0',
    WEBHOOK_SECRET: 'generic-webhook-secret-0123456789ab',
    WEBHOOK_BODY_SECRET_COMPAT_ENABLED: undefined,
    WEBHOOK_BODY_SECRET_COMPAT_UNTIL: undefined,
    WEBHOOK_QUERY_SECRET_COMPAT_ENABLED: undefined,
    WEBHOOK_QUERY_SECRET_COMPAT_UNTIL: undefined,
    SEERR_WEBHOOK_SECRET: SEERR_SECRET,
    JELLYFIN_WEBHOOK_SECRET: JELLYFIN_SECRET,
    ...overrides,
  }, async () => {
    const server = new WebhookServer();
    register?.(server);
    server.start();
    try {
      await callback(`http://127.0.0.1:${portOf(server)}`);
    } finally {
      server.stop();
    }
  });
}

describe('WebhookServer media routing', () => {
  test('Seerr authenticates by header and falls back from username to email', async () => {
    const sendDiscord = mock(async () => {});
    const usernameSpy = spyOn(ServiceBindingService, 'findByExternalUsername').mockResolvedValue([]);
    const emailSpy = spyOn(ServiceBindingService, 'findByExternalEmail').mockResolvedValue([
      { id: 1, userId: 'user-1', platform: 'discord' },
    ] as never);
    const roomsSpy = spyOn(NotificationSubscriptionService, 'getNotificationRooms').mockResolvedValue([
      { chatRoomId: 'room-a', platform: 'discord' },
    ]);
    const adminSpy = spyOn(NotificationSubscriptionService, 'getAdminNotificationRooms').mockResolvedValue([]);

    try {
      await withMediaServer({}, async baseUrl => {
        const response = await Bun.fetch(`${baseUrl}/webhook/seerr`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Secret': SEERR_SECRET,
          },
          body: JSON.stringify({
            notification_type: 'MEDIA_APPROVED',
            subject: 'Dark',
            message: 'Approved!',
            requestedBy_username: 'missing-user',
            requestedBy_email: 'alice@example.com',
          }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, delivered: 1 });
        expect(usernameSpy).toHaveBeenCalled();
        expect(emailSpy).toHaveBeenCalled();
        expect(roomsSpy).toHaveBeenCalledTimes(1);
        // Senders are invoked as (chatId, text, signal) so delivery can be
        // cancelled when the webhook request is aborted.
        expect(sendDiscord).toHaveBeenCalledWith(
          'room-a',
          expect.stringContaining('Approved'),
          expect.any(AbortSignal),
        );
      }, server => server.registerSender('discord', sendDiscord));
    } finally {
      usernameSpy.mockRestore();
      emailSpy.mockRestore();
      roomsSpy.mockRestore();
      adminSpy.mockRestore();
    }
  });

  test('Jellyfin authenticates by header and deduplicates target rooms', async () => {
    const sendDiscord = mock(async () => {});
    const userSpy = spyOn(ServiceBindingService, 'findByExternalUser').mockResolvedValue([
      { id: 1, userId: 'user-1', platform: 'discord' },
    ] as never);
    const usernameSpy = spyOn(ServiceBindingService, 'findByExternalUsername').mockResolvedValue([
      { id: 1, userId: 'user-1', platform: 'discord' },
      { id: 2, userId: 'user-2', platform: 'discord' },
    ] as never);
    const roomsSpy = spyOn(NotificationSubscriptionService, 'getNotificationRooms').mockImplementation(async (userId: string) => {
      if (userId === 'user-1') {
        return [
          { chatRoomId: 'room-a', platform: 'discord' },
          { chatRoomId: 'shared', platform: 'discord' },
        ];
      }
      return [
        { chatRoomId: 'shared', platform: 'discord' },
        { chatRoomId: 'room-b', platform: 'discord' },
      ];
    });
    const adminSpy = spyOn(NotificationSubscriptionService, 'getAdminNotificationRooms').mockResolvedValue([]);

    try {
      await withMediaServer({}, async baseUrl => {
        const response = await Bun.fetch(`${baseUrl}/webhook/jellyfin`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Secret': JELLYFIN_SECRET,
          },
          body: JSON.stringify({
            NotificationType: 'PlaybackStart',
            Name: 'Episode Name',
            UserId: 'jf-user-1',
            NotificationUsername: 'alice',
            DeviceName: 'Living Room',
          }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, delivered: 3 });
        expect(userSpy).toHaveBeenCalled();
        expect(usernameSpy).toHaveBeenCalled();
        expect(roomsSpy).toHaveBeenCalledTimes(2);
        expect(sendDiscord).toHaveBeenCalledTimes(3);
      }, server => server.registerSender('discord', sendDiscord));
    } finally {
      usernameSpy.mockRestore();
      userSpy.mockRestore();
      roomsSpy.mockRestore();
      adminSpy.mockRestore();
    }
  });

  test('media webhook returns no-subscriber note when nobody is linked', async () => {
    const usernameSpy = spyOn(ServiceBindingService, 'findByExternalUsername').mockResolvedValue([]);
    const emailSpy = spyOn(ServiceBindingService, 'findByExternalEmail').mockResolvedValue([]);
    const adminSpy = spyOn(NotificationSubscriptionService, 'getAdminNotificationRooms').mockResolvedValue([]);

    try {
      await withMediaServer({}, async baseUrl => {
        const response = await Bun.fetch(`${baseUrl}/webhook/seerr`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Secret': SEERR_SECRET,
          },
          body: JSON.stringify({
            notification_type: 'MEDIA_PENDING',
            subject: 'Dark',
            message: 'Pending',
            requestedBy_username: 'alice',
            requestedBy_email: 'alice@example.com',
          }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, delivered: 0, note: 'No subscribers' });
      });
    } finally {
      usernameSpy.mockRestore();
      emailSpy.mockRestore();
      adminSpy.mockRestore();
    }
  });

  test('Seerr and Jellyfin fail closed without configured secrets', async () => {
    await withMediaServer({
      SEERR_WEBHOOK_SECRET: undefined,
      JELLYFIN_WEBHOOK_SECRET: undefined,
    }, async baseUrl => {
      for (const route of ['seerr', 'jellyfin']) {
        const response = await Bun.fetch(`${baseUrl}/webhook/${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        expect(response.status).toBe(503);
      }
    });
  });

  test('media routes reject invalid secrets before database lookups', async () => {
    const usernameSpy = spyOn(ServiceBindingService, 'findByExternalUsername');
    const emailSpy = spyOn(ServiceBindingService, 'findByExternalEmail');
    const userSpy = spyOn(ServiceBindingService, 'findByExternalUser');

    try {
      await withMediaServer({}, async baseUrl => {
        const seerr = await Bun.fetch(`${baseUrl}/webhook/seerr`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': `${SEERR_SECRET}x` },
          body: JSON.stringify({ notification_type: 'MEDIA_PENDING' }),
        });
        expect(seerr.status).toBe(401);

        const jellyfin = await Bun.fetch(`${baseUrl}/webhook/jellyfin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': `${JELLYFIN_SECRET}x` },
          body: JSON.stringify({ NotificationType: 'ItemAdded' }),
        });
        expect(jellyfin.status).toBe(401);
      });
      expect(usernameSpy).not.toHaveBeenCalled();
      expect(emailSpy).not.toHaveBeenCalled();
      expect(userSpy).not.toHaveBeenCalled();
    } finally {
      usernameSpy.mockRestore();
      emailSpy.mockRestore();
      userSpy.mockRestore();
    }
  });
});
