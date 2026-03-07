import { beforeEach, describe, expect, mock, test } from 'bun:test';

const authRows = new Map<string, string>();
const deletedIds: string[] = [];
const fromObjectCalls: unknown[] = [];
let failWrites = false;
let failDeletes = false;
let initCredsCalls = 0;

function extractStringValues(node: unknown): string[] {
  const values: string[] = [];
  const visited = new Set<object>();

  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    if (visited.has(obj)) return;
    visited.add(obj);

    if ('value' in obj && typeof obj.value === 'string') {
      values.push(obj.value);
    }

    for (const child of Object.values(obj)) {
      if (Array.isArray(child)) {
        child.forEach(walk);
      } else {
        walk(child);
      }
    }
  };

  walk(node);
  return values;
}

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));
mock.module('@whiskeysockets/baileys/lib/Utils/generics', () => ({
  BufferJSON: {
    replacer: (_key: string, value: unknown) => value,
    reviver: (_key: string, value: unknown) => value,
  },
}));
mock.module('@whiskeysockets/baileys', () => ({
  initAuthCreds: () => {
    initCredsCalls++;
    return { id: 'fresh-creds' };
  },
  proto: {
    Message: {
      AppStateSyncKeyData: {
        fromObject: (value: unknown) => {
          fromObjectCalls.push(value);
          return { converted: value };
        },
      },
    },
  },
}));
mock.module('../src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => ({
          limit: async () => {
            const [id] = extractStringValues(condition);
            const data = id ? authRows.get(id) : undefined;
            return data ? [{ id, data }] : [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: ({ id, data }: { id: string; data: string }) => ({
        onConflictDoUpdate: async ({ set }: { set: { data: string } }) => {
          if (failWrites) throw new Error('write failed');
          authRows.set(id, set.data ?? data);
        },
      }),
    }),
    delete: () => ({
      where: async (condition: unknown) => {
        if (failDeletes) throw new Error('delete failed');
        const [id] = extractStringValues(condition);
        if (id) {
          deletedIds.push(id);
          authRows.delete(id);
        }
      },
    }),
  },
}));

import { useDBAuthState } from '../src/utils/useDBAuthState';

describe('useDBAuthState', () => {
  beforeEach(() => {
    authRows.clear();
    deletedIds.length = 0;
    fromObjectCalls.length = 0;
    failWrites = false;
    failDeletes = false;
    initCredsCalls = 0;
  });

  test('falls back to initAuthCreds when creds are missing or malformed', async () => {
    authRows.set('creds', '{bad json');

    const { state } = await useDBAuthState();

    expect(state.creds).toEqual({ id: 'fresh-creds' });
    expect(initCredsCalls).toBe(1);
  });

  test('reads existing creds and persists them through saveCreds', async () => {
    authRows.set('creds', JSON.stringify({ id: 'stored-creds' }));

    const { state, saveCreds } = await useDBAuthState();
    expect(state.creds).toEqual({ id: 'stored-creds' });

    await saveCreds();
    expect(authRows.get('creds')).toBe(JSON.stringify({ id: 'stored-creds' }));
  });

  test('keys.get converts app-state-sync-key records through proto helpers', async () => {
    authRows.set('app-state-sync-key-abc', JSON.stringify({ keyData: 'value' }));

    const { state } = await useDBAuthState();
    const data = await state.keys.get('app-state-sync-key', ['abc']);

    expect(fromObjectCalls).toEqual([{ keyData: 'value' }]);
    expect(data.abc).toEqual({ converted: { keyData: 'value' } });
  });

  test('keys.set writes present values and removes null values sequentially', async () => {
    authRows.set('session-old', JSON.stringify({ stale: true }));

    const { state } = await useDBAuthState();
    await state.keys.set({
      session: {
        fresh: { token: 'abc' },
        old: null,
      },
    });

    expect(authRows.get('session-fresh')).toBe(JSON.stringify({ token: 'abc' }));
    expect(authRows.has('session-old')).toBe(false);
    expect(deletedIds).toEqual(['session-old']);
  });

  test('keys.get returns null entries for missing ids', async () => {
    const { state } = await useDBAuthState();
    const data = await state.keys.get('session', ['missing']);

    expect(data).toEqual({ missing: null });
  });

  test('swallows write and delete failures', async () => {
    const { state, saveCreds } = await useDBAuthState();
    failWrites = true;
    failDeletes = true;

    await expect(saveCreds()).resolves.toBeUndefined();
    await expect(state.keys.set({ session: { broken: { ok: true }, remove: null } })).resolves.toBeUndefined();
  });
});