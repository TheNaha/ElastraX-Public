import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

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

describe('WebhookServer media routing', () => {
  const originalSeerrSecret = process.env.SEERR_WEBHOOK_SECRET;
  const originalJellyfinSecret = process.env.JELLYFIN_WEBHOOK_SECRET;

  afterEach(() => {
    delete process.env.WEBHOOK_ENABLED;
    delete process.env.WEBHOOK_PORT;
    process.env.SEERR_WEBHOOK_SECRET = originalSeerrSecret;
    process.env.JELLYFIN_WEBHOOK_SECRET = originalJellyfinSecret;
  });

  test('Seerr routing falls back from username to email and delivers once', async () => {
    process.env.WEBHOOK_ENABLED = 'true';
    process.env.WEBHOOK_PORT = '0';
    delete process.env.SEERR_WEBHOOK_SECRET;
    delete process.env.JELLYFIN_WEBHOOK_SECRET;

    const sendDiscord = mock(async () => {});
    const usernameSpy = spyOn(ServiceBindingService, 'findByExternalUsername').mockResolvedValue([]);
    const emailSpy = spyOn(ServiceBindingService, 'findByExternalEmail').mockResolvedValue([
      { id: 1, userId: 'user-1', platform: 'discord' } as any,
    ]);
    const roomsSpy = spyOn(NotificationSubscriptionService, 'getNotificationRooms').mockResolvedValue([
      { chatRoomId: 'room-a', platform: 'discord' },
    ]);
    const adminSpy = spyOn(NotificationSubscriptionService, 'getAdminNotificationRooms').mockResolvedValue([]);

    const server = new WebhookServer();
    server.registerSender('discord', sendDiscord);
    server.start();

    try {
      const port = (server as any).server?.port;
      const res = await fetch(`http://127.0.0.1:${port}/webhook/seerr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notification_type: 'MEDIA_APPROVED',
          subject: 'Dark',
          message: 'Approved!',
          requestedBy_username: 'missing-user',
          requestedBy_email: 'alice@example.com',
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, delivered: 1 });
      expect(usernameSpy).toHaveBeenCalled();
      expect(emailSpy).toHaveBeenCalled();
      expect(roomsSpy).toHaveBeenCalledTimes(1);
      expect(sendDiscord).toHaveBeenCalledWith('room-a', expect.stringContaining('Approved'), 'discord');
    } finally {
      server.stop();
      usernameSpy.mockRestore();
      emailSpy.mockRestore();
      roomsSpy.mockRestore();
      adminSpy.mockRestore();
    }
  });

  test('Jellyfin routing tries both identifiers and deduplicates target rooms', async () => {
    process.env.WEBHOOK_ENABLED = 'true';
    process.env.WEBHOOK_PORT = '0';
    delete process.env.SEERR_WEBHOOK_SECRET;
    delete process.env.JELLYFIN_WEBHOOK_SECRET;

    const sendDiscord = mock(async () => {});
    const userSpy = spyOn(ServiceBindingService, 'findByExternalUser').mockResolvedValue([
      { id: 1, userId: 'user-1', platform: 'discord' } as any,
    ]);
    const usernameSpy = spyOn(ServiceBindingService, 'findByExternalUsername').mockResolvedValue([
      { id: 1, userId: 'user-1', platform: 'discord' } as any,
      { id: 2, userId: 'user-2', platform: 'discord' } as any,
    ]);
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

    const server = new WebhookServer();
    server.registerSender('discord', sendDiscord);
    server.start();

    try {
      const port = (server as any).server?.port;
      const res = await fetch(`http://127.0.0.1:${port}/webhook/jellyfin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          NotificationType: 'PlaybackStart',
          Name: 'Episode Name',
          UserId: 'jf-user-1',
          NotificationUsername: 'alice',
          DeviceName: 'Living Room',
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, delivered: 3 });
      expect(userSpy).toHaveBeenCalled();
      expect(usernameSpy).toHaveBeenCalled();
      expect(roomsSpy).toHaveBeenCalledTimes(2);
      expect(sendDiscord).toHaveBeenCalledTimes(3);
    } finally {
      server.stop();
      userSpy.mockRestore();
      usernameSpy.mockRestore();
      roomsSpy.mockRestore();
      adminSpy.mockRestore();
    }
  });

  test('media webhook returns no-subscriber note when nobody is linked', async () => {
    process.env.WEBHOOK_ENABLED = 'true';
    process.env.WEBHOOK_PORT = '0';
    delete process.env.SEERR_WEBHOOK_SECRET;
    delete process.env.JELLYFIN_WEBHOOK_SECRET;

    const usernameSpy = spyOn(ServiceBindingService, 'findByExternalUsername').mockResolvedValue([]);
    const emailSpy = spyOn(ServiceBindingService, 'findByExternalEmail').mockResolvedValue([]);
    const adminSpy = spyOn(NotificationSubscriptionService, 'getAdminNotificationRooms').mockResolvedValue([]);

    const server = new WebhookServer();
    server.start();

    try {
      const port = (server as any).server?.port;
      const res = await fetch(`http://127.0.0.1:${port}/webhook/seerr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notification_type: 'MEDIA_PENDING',
          subject: 'Dark',
          message: 'Pending',
          requestedBy_username: 'alice',
          requestedBy_email: 'alice@example.com',
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, delivered: 0, note: 'No subscribers' });
    } finally {
      server.stop();
      usernameSpy.mockRestore();
      emailSpy.mockRestore();
      adminSpy.mockRestore();
    }
  });
});
