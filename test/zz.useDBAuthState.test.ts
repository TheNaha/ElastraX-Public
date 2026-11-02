import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withEnvironment } from './helpers/env';
import { db } from '../src/db';
import { useDBAuthState } from '../src/utils/useDBAuthState';
import { waAuthState } from '../src/db/schema';

const fromObjectCalls: unknown[] = [];
let initCredsCalls = 0;

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

function makeLegacyDirectory(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'elastrax-wa-auth-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents, 'utf8');
  }
  return directory;
}

async function seedRow(id: string, data: string): Promise<void> {
  await db.insert(waAuthState).values({ id, data }).onConflictDoUpdate({
    target: waAuthState.id,
    set: { data },
  }).run();
}

async function readRow(id: string): Promise<string | undefined> {
  const rows = await db.select().from(waAuthState).where(eq(waAuthState.id, id));
  return rows[0]?.data;
}

describe('useDBAuthState', () => {
  beforeEach(async () => {
    await db.delete(waAuthState).run();
    fromObjectCalls.length = 0;
    initCredsCalls = 0;
  });

  test('falls back to initAuthCreds when no creds row exists', async () => {
    const { state } = await useDBAuthState();

    expect(state.creds).toEqual({ id: 'fresh-creds' } as unknown as typeof state.creds);
    expect(initCredsCalls).toBe(1);
  });

  test('fails closed on a corrupt creds row instead of silently re-pairing the device', async () => {
    await seedRow('creds', '{bad json');

    await expect(useDBAuthState()).rejects.toThrow('Corrupt WhatsApp auth state row: creds');
    expect(initCredsCalls).toBe(0);
  });

  test('reads existing creds and persists them through saveCreds', async () => {
    await seedRow('creds', JSON.stringify({ id: 'stored-creds' }));

    const { state, saveCreds } = await useDBAuthState();
    expect(state.creds).toEqual({ id: 'stored-creds' } as unknown as typeof state.creds);
    expect(initCredsCalls).toBe(0);

    await saveCreds();
    expect(await readRow('creds')).toBe(JSON.stringify({ id: 'stored-creds' }));
  });

  test('saveCreds is serialised so concurrent callers cannot interleave writes', async () => {
    await seedRow('creds', JSON.stringify({ id: 'stored-creds' }));

    const { saveCreds } = await useDBAuthState();
    await Promise.all([saveCreds(), saveCreds(), saveCreds()]);

    expect(await readRow('creds')).toBe(JSON.stringify({ id: 'stored-creds' }));
  });

  test('imports a legacy auth directory when WA_AUTH_IMPORT_DIR is set', async () => {
    const directory = makeLegacyDirectory({
      'creds.json': JSON.stringify({ id: 'legacy-creds' }),
      'app-state-sync-key-abc.json': JSON.stringify({ keyData: 'value' }),
      'unrelated.txt': 'ignored',
    });

    try {
      await withEnvironment({ WA_AUTH_IMPORT_DIR: directory }, async () => {
        const { state } = await useDBAuthState();
        expect(state.creds).toEqual({ id: 'legacy-creds' } as unknown as typeof state.creds);
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    expect(await readRow('creds')).toBe(JSON.stringify({ id: 'legacy-creds' }));
    expect(await readRow('app-state-sync-key-abc')).toBe(JSON.stringify({ keyData: 'value' }));
    expect(await readRow('unrelated-txt')).toBeUndefined();
    expect(initCredsCalls).toBe(0);
  });

  test('prefers stored creds over a configured legacy import directory', async () => {
    await seedRow('creds', JSON.stringify({ id: 'stored-creds' }));
    const directory = makeLegacyDirectory({ 'creds.json': JSON.stringify({ id: 'legacy-creds' }) });

    try {
      await withEnvironment({ WA_AUTH_IMPORT_DIR: directory }, async () => {
        const { state } = await useDBAuthState();
        expect(state.creds).toEqual({ id: 'stored-creds' } as unknown as typeof state.creds);
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('keys.get converts app-state-sync-key records through proto helpers', async () => {
    await seedRow('app-state-sync-key-abc', JSON.stringify({ keyData: 'value' }));

    const { state } = await useDBAuthState();
    const data = await state.keys.get('app-state-sync-key', ['abc']);

    expect(fromObjectCalls).toEqual([{ keyData: 'value' }]);
    expect(data.abc).toEqual({ converted: { keyData: 'value' } } as unknown as typeof data.abc);
  });

  test('keys.set writes present values and removes null values', async () => {
    await seedRow('session-old', JSON.stringify({ stale: true }));

    const { state } = await useDBAuthState();
    await state.keys.set({
      session: {
        fresh: { token: 'abc' },
        old: null,
      },
    } as unknown as Parameters<typeof state.keys.set>[0]);

    expect(await readRow('session-fresh')).toBe(JSON.stringify({ token: 'abc' }));
    expect(await readRow('session-old')).toBeUndefined();
  });

  test('keys.get returns null entries for missing ids', async () => {
    const { state } = await useDBAuthState();
    const data = await state.keys.get('session', ['missing']);

    expect(data).toEqual({ missing: null } as unknown as typeof data);
  });

  test('keeps serving mutations after a corrupt row has been observed', async () => {
    await seedRow('creds', '{bad json');
    await expect(useDBAuthState()).rejects.toThrow('Corrupt WhatsApp auth state row: creds');

    await seedRow('creds', JSON.stringify({ id: 'recovered-creds' }));
    const { state, saveCreds } = await useDBAuthState();
    expect(state.creds).toEqual({ id: 'recovered-creds' } as unknown as typeof state.creds);
    await expect(saveCreds()).resolves.toBeUndefined();
  });
});
