import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { NotificationSubscriptionService } from '../src/utils/NotificationSubscriptionService';
import { ServiceBindingService } from '../src/utils/ServiceBindingService';

function createWhereResult<T>(result: T) {
  const promise = Promise.resolve(result);
  return {
    limit: mock(async () => result),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
}

function createFakeDb(selectResults: unknown[]) {
  const queue = [...selectResults];
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  const deletes: unknown[] = [];

  const db = {
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => createWhereResult(queue.shift() ?? [])),
      })),
    })),
    insert: mock(() => ({
      values: mock(async (value: unknown) => {
        inserts.push(value);
      }),
    })),
    update: mock(() => ({
      set: mock((value: unknown) => {
        updates.push(value);
        return {
          where: mock(async () => {}),
        };
      }),
    })),
    delete: mock(() => ({
      where: mock(async (value: unknown) => {
        deletes.push(value);
      }),
    })),
  };

  return { db, inserts, updates, deletes };
}

// A real drizzle table so the service can detect its canonical `roomKey` column;
// a plain object double would deliberately exercise the pre-migration path.
const subscriptionsTable = sqliteTable('notification_subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  platform: text('platform').notNull(),
  serviceType: text('service_type').notNull(),
  chatRoomId: text('chat_room_id').notNull(),
  roomKey: text('room_key'),
  notifyTypes: text('notify_types'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});

/** The same shape without a `roomKey` column: a pre-migration table. */
const legacySubscriptionsTable = sqliteTable('notification_subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  platform: text('platform').notNull(),
  serviceType: text('service_type').notNull(),
  chatRoomId: text('chat_room_id').notNull(),
  notifyTypes: text('notify_types'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});

type SubscriptionTable = typeof import('../src/db/schema').notificationSubscriptions;
type SubscriptionRow = typeof import('../src/db/schema').notificationSubscriptions.$inferSelect;

describe('NotificationSubscriptionService', () => {
  afterEach(() => {
    NotificationSubscriptionService.setDepsForTesting(null);
  });

  test('subscribe inserts new rows and updates existing rows', async () => {
    const fake = createFakeDb([[], [{ id: 5 }]]);
    NotificationSubscriptionService.setDepsForTesting({
      db: fake.db as any,
      notificationSubscriptions: subscriptionsTable,
    });

    await NotificationSubscriptionService.subscribe({
      userId: 'user-1',
      platform: 'discord',
      serviceType: 'all',
      chatRoomId: 'room-a',
      notifyTypes: ['added'],
    });
    await NotificationSubscriptionService.subscribe({
      userId: 'user-1',
      platform: 'discord',
      serviceType: 'all',
      chatRoomId: 'room-a',
      notifyTypes: ['updated'],
    });

    expect(fake.inserts).toHaveLength(1);
    // The insert dual-writes the canonical key next to the legacy raw room id.
    expect(fake.inserts[0]).toMatchObject({ chatRoomId: 'room-a', roomKey: 'room:discord:room-a' });
    // A row the migration has not backfilled yet is repaired on update.
    expect(fake.updates).toEqual([{ notifyTypes: '["updated"]', roomKey: 'room:discord:room-a' }]);
  });

  test('subscribe keeps working on a table without a room_key column', async () => {
    const fake = createFakeDb([[]]);
    NotificationSubscriptionService.setDepsForTesting({
      db: fake.db as any,
      notificationSubscriptions: legacySubscriptionsTable as unknown as SubscriptionTable,
    });

    await NotificationSubscriptionService.subscribe({
      userId: 'user-1',
      platform: 'discord',
      serviceType: 'all',
      chatRoomId: 'room-a',
    });

    expect(fake.inserts[0]).toMatchObject({ chatRoomId: 'room-a' });
    expect(fake.inserts[0]).not.toHaveProperty('roomKey');
  });

  test('subscribe normalises a canonical key back to the raw provider room id', async () => {
    const fake = createFakeDb([[]]);
    NotificationSubscriptionService.setDepsForTesting({
      db: fake.db as any,
      notificationSubscriptions: subscriptionsTable,
    });

    await NotificationSubscriptionService.subscribe({
      userId: 'user-1',
      platform: 'discord',
      serviceType: 'all',
      chatRoomId: 'room:discord:room-a',
      roomKey: 'room:discord:room-a',
    });

    expect(fake.inserts[0]).toMatchObject({ chatRoomId: 'room-a', roomKey: 'room:discord:room-a' });
  });

  test('subscribe refuses a canonical key from another platform without owner permission', async () => {
    const fake = createFakeDb([[]]);
    NotificationSubscriptionService.setDepsForTesting({
      db: fake.db as any,
      notificationSubscriptions: subscriptionsTable,
    });

    await expect(NotificationSubscriptionService.subscribe({
      userId: 'user-1',
      platform: 'discord',
      serviceType: 'all',
      chatRoomId: 'room:whatsapp:room-a',
      currentRoomId: 'room-a',
      currentRoomKey: 'room:discord:room-a',
    })).rejects.toThrow('Foreign notification rooms require owner permission.');
    expect(fake.inserts).toHaveLength(0);
  });

  test('unsubscribe returns false for missing rows and true when a row exists', async () => {
    const fake = createFakeDb([[], [{ id: 7 }]]);
    NotificationSubscriptionService.setDepsForTesting({
      db: fake.db as any,
      notificationSubscriptions: subscriptionsTable,
    });

    await expect(NotificationSubscriptionService.unsubscribe('user-1', 'discord', 'all', 'room-a')).resolves.toBe(false);
    await expect(NotificationSubscriptionService.unsubscribe('user-1', 'discord', 'all', 'room-a')).resolves.toBe(true);
    expect(fake.deletes).toHaveLength(1);
  });

  test('getSubscriptions and getSubscribersForService return queued rows', async () => {
    const subA = { chatRoomId: 'room-a', platform: 'discord', serviceType: 'seerr' } as unknown as SubscriptionRow;
    const subB = { chatRoomId: 'room-b', platform: 'discord', serviceType: 'all' } as unknown as SubscriptionRow;
    const fake = createFakeDb([[subA], [subA, subB]]);
    NotificationSubscriptionService.setDepsForTesting({
      db: fake.db as any,
      notificationSubscriptions: subscriptionsTable,
    });

    expect(await NotificationSubscriptionService.getSubscriptions('user-1', 'discord', 'seerr')).toEqual([subA]);
    expect(await NotificationSubscriptionService.getSubscribersForService('seerr')).toEqual([subA, subB]);
  });

  test('getNotificationRooms merges service-specific and all subscriptions without duplicates', async () => {
    const fake = createFakeDb([
      [
        { chatRoomId: 'room-a', platform: 'discord', serviceType: 'seerr' },
        { chatRoomId: 'shared', platform: 'discord', serviceType: 'seerr' },
        { chatRoomId: 'shared', platform: 'discord', serviceType: 'all' },
        { chatRoomId: 'room-b', platform: 'discord', serviceType: 'all' },
      ],
    ]);
    NotificationSubscriptionService.setDepsForTesting({
      db: fake.db as any,
      notificationSubscriptions: subscriptionsTable,
    });

    const rooms = await NotificationSubscriptionService.getNotificationRooms('user-1', 'discord', 'seerr');
    // `chatRoomId` stays the raw provider room id; `roomKey` is derived when the
    // legacy row has not been backfilled yet.
    expect(rooms).toEqual([
      { chatRoomId: 'room-a', roomKey: 'room:discord:room-a', platform: 'discord' },
      { chatRoomId: 'shared', roomKey: 'room:discord:shared', platform: 'discord' },
      { chatRoomId: 'room-b', roomKey: 'room:discord:room-b', platform: 'discord' },
    ]);
  });

  test('getAdminNotificationRooms uses the requested service and deduplicates rooms across admin users', async () => {
    const adminSpy = spyOn(ServiceBindingService, 'getAdminBindings').mockResolvedValue([
      { userId: 'admin-1', platform: 'discord' } as any,
      { userId: 'admin-2', platform: 'discord' } as any,
    ]);
    const roomsSpy = spyOn(NotificationSubscriptionService, 'getNotificationRooms').mockImplementation(async (userId, _platform, serviceType) => {
      expect(serviceType).toBe('seerr');
      if (userId === 'admin-1') {
        return [
          { chatRoomId: 'room-a', roomKey: 'room:discord:room-a', platform: 'discord' },
          { chatRoomId: 'shared', roomKey: 'room:discord:shared', platform: 'discord' },
        ];
      }

      return [
        { chatRoomId: 'shared', roomKey: 'room:discord:shared', platform: 'discord' },
        { chatRoomId: 'room-b', roomKey: 'room:discord:room-b', platform: 'discord' },
      ];
    });

    const rooms = await NotificationSubscriptionService.getAdminNotificationRooms('seerr');
    expect(rooms).toEqual([
      { chatRoomId: 'room-a', roomKey: 'room:discord:room-a', platform: 'discord', userId: 'admin-1' },
      { chatRoomId: 'shared', roomKey: 'room:discord:shared', platform: 'discord', userId: 'admin-1' },
      { chatRoomId: 'room-b', roomKey: 'room:discord:room-b', platform: 'discord', userId: 'admin-2' },
    ]);
    expect(adminSpy).toHaveBeenCalledWith('seerr');
    expect(roomsSpy).toHaveBeenCalledTimes(2);

    adminSpy.mockRestore();
    roomsSpy.mockRestore();
  });
});
