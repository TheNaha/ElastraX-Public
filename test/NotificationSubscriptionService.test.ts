import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
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

const subscriptionsTable = {
  id: 'id',
  userId: 'userId',
  platform: 'platform',
  serviceType: 'serviceType',
  chatRoomId: 'chatRoomId',
  notifyTypes: 'notifyTypes',
} as any;

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
    expect(fake.updates).toEqual([{ notifyTypes: '["updated"]' }]);
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
    const subA = { chatRoomId: 'room-a', platform: 'discord', serviceType: 'seerr' };
    const subB = { chatRoomId: 'room-b', platform: 'discord', serviceType: 'all' };
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
      ],
      [
        { chatRoomId: 'shared', platform: 'discord', serviceType: 'all' },
        { chatRoomId: 'room-b', platform: 'discord', serviceType: 'all' },
      ],
    ]);
    NotificationSubscriptionService.setDepsForTesting({
      db: fake.db as any,
      notificationSubscriptions: subscriptionsTable,
    });

    const rooms = await NotificationSubscriptionService.getNotificationRooms('user-1', 'discord', 'seerr');
    expect(rooms).toEqual([
      { chatRoomId: 'room-a', platform: 'discord' },
      { chatRoomId: 'shared', platform: 'discord' },
      { chatRoomId: 'room-b', platform: 'discord' },
    ]);
  });

  test('getAdminNotificationRooms deduplicates rooms across admin users', async () => {
    const adminSpy = spyOn(ServiceBindingService, 'getAdminBindings').mockResolvedValue([
      { userId: 'admin-1', platform: 'discord' } as any,
      { userId: 'admin-2', platform: 'discord' } as any,
    ]);
    const fake = createFakeDb([
      [
        { chatRoomId: 'room-a', platform: 'discord', serviceType: 'all' },
        { chatRoomId: 'shared', platform: 'discord', serviceType: 'all' },
      ],
      [
        { chatRoomId: 'shared', platform: 'discord', serviceType: 'all' },
        { chatRoomId: 'room-b', platform: 'discord', serviceType: 'all' },
      ],
    ]);
    NotificationSubscriptionService.setDepsForTesting({
      db: fake.db as any,
      notificationSubscriptions: subscriptionsTable,
    });

    const rooms = await NotificationSubscriptionService.getAdminNotificationRooms('seerr');
    expect(rooms).toEqual([
      { chatRoomId: 'room-a', platform: 'discord', userId: 'admin-1' },
      { chatRoomId: 'shared', platform: 'discord', userId: 'admin-1' },
      { chatRoomId: 'room-b', platform: 'discord', userId: 'admin-2' },
    ]);

    adminSpy.mockRestore();
  });
});
