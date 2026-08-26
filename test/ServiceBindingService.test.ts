import { afterEach, describe, expect, mock, test } from 'bun:test';
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

const serviceBindingsTable = {
  id: 'id',
  userId: 'userId',
  platform: 'platform',
  serviceType: 'serviceType',
  externalUserId: 'externalUserId',
  externalUsername: 'externalUsername',
  externalEmail: 'externalEmail',
  metadata: 'metadata',
} as any;

type BindingRow = typeof import('../src/db/schema').serviceBindings.$inferSelect;

describe('ServiceBindingService', () => {
  afterEach(() => {
    ServiceBindingService.setDepsForTesting(null);
  });

  test('bind inserts a new binding when none exists', async () => {
    const fake = createFakeDb([[]]);
    ServiceBindingService.setDepsForTesting({
      db: fake.db as any,
      serviceBindings: serviceBindingsTable,
    });

    await ServiceBindingService.bind({
      userId: 'user-1',
      platform: 'discord',
      serviceType: 'seerr',
      externalUserId: '99',
      externalUsername: 'alice',
      externalEmail: 'alice@example.com',
      metadata: '{"isAdmin":true}',
    });

    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]).toMatchObject({
      userId: 'user-1',
      platform: 'discord',
      serviceType: 'seerr',
      externalUserId: '99',
      externalUsername: 'alice',
      externalEmail: 'alice@example.com',
      metadata: '{"isAdmin":true}',
    });
  });

  test('bind updates an existing binding and preserves metadata fallback', async () => {
    const fake = createFakeDb([[{
      id: 7,
      metadata: '{"keep":true}',
    }]]);
    ServiceBindingService.setDepsForTesting({
      db: fake.db as any,
      serviceBindings: serviceBindingsTable,
    });

    await ServiceBindingService.bind({
      userId: 'user-1',
      platform: 'discord',
      serviceType: 'jellyfin',
      externalUserId: '123',
      externalUsername: 'alice-new',
    });

    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]).toEqual({
      externalUserId: '123',
      externalUsername: 'alice-new',
      externalEmail: null,
      metadata: '{"keep":true}',
    });
  });

  test('lookup helpers and admin filtering return the expected rows', async () => {
    const normalBinding = {
      id: 1,
      userId: 'user-1',
      platform: 'discord',
      serviceType: 'seerr',
      externalUserId: '11',
      externalUsername: 'alice',
      externalEmail: 'alice@example.com',
      metadata: null,
    } as unknown as BindingRow;
    const adminBinding = {
      id: 2,
      userId: 'user-2',
      platform: 'whatsapp',
      serviceType: 'seerr',
      externalUserId: '22',
      externalUsername: 'bob',
      externalEmail: 'bob@example.com',
      metadata: '{"isAdmin":true}',
    } as unknown as BindingRow;
    const fake = createFakeDb([
      [normalBinding],
      [normalBinding, adminBinding],
      [normalBinding],
      [adminBinding],
      [normalBinding, adminBinding],
      [normalBinding, adminBinding, { ...normalBinding, id: 3, metadata: 'not-json' }],
    ]);
    ServiceBindingService.setDepsForTesting({
      db: fake.db as any,
      serviceBindings: serviceBindingsTable,
    });

    expect(await ServiceBindingService.getBinding('user-1', 'discord', 'seerr')).toEqual(normalBinding);
    expect(await ServiceBindingService.getBindings('user-1', 'discord')).toHaveLength(2);
    expect(await ServiceBindingService.findByExternalUser('seerr', '11')).toEqual([normalBinding]);
    expect(await ServiceBindingService.findByExternalEmail('seerr', 'bob@example.com')).toEqual([adminBinding]);
    expect(await ServiceBindingService.findByExternalUsername('seerr', 'alice')).toHaveLength(2);

    const admins = await ServiceBindingService.getAdminBindings('seerr');
    expect(admins).toEqual([adminBinding]);
  });

  test('updateMetadata and unbind return false when the binding does not exist', async () => {
    const fake = createFakeDb([[], []]);
    ServiceBindingService.setDepsForTesting({
      db: fake.db as any,
      serviceBindings: serviceBindingsTable,
    });

    await expect(ServiceBindingService.updateMetadata('user-1', 'discord', 'seerr', '{"x":1}')).resolves.toBe(false);
    await expect(ServiceBindingService.unbind('user-1', 'discord', 'seerr')).resolves.toBe(false);
    expect(fake.updates).toHaveLength(0);
    expect(fake.deletes).toHaveLength(0);
  });

  test('updateMetadata and unbind operate on existing bindings', async () => {
    const binding = {
      id: 9,
      userId: 'user-1',
      platform: 'discord',
      serviceType: 'jellyfin',
      externalUserId: 'abc',
      externalUsername: 'alice',
      metadata: '{"isAdmin":false}',
    };
    const fake = createFakeDb([[binding], [binding]]);
    ServiceBindingService.setDepsForTesting({
      db: fake.db as any,
      serviceBindings: serviceBindingsTable,
    });

    await expect(ServiceBindingService.updateMetadata('user-1', 'discord', 'jellyfin', '{"isAdmin":true}')).resolves.toBe(true);
    await expect(ServiceBindingService.unbind('user-1', 'discord', 'jellyfin')).resolves.toBe(true);
    expect(fake.updates[0]).toEqual({ metadata: '{"isAdmin":true}' });
    expect(fake.deletes).toHaveLength(1);
  });
});
