import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { userIdentities } from '../src/db/schema';
import { IdentityService } from '../src/utils/IdentityService';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

describe('IdentityService', () => {
  let sqlite: Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    IdentityService.setDepsForTesting({ db: db as typeof import('../src/db').db, userIdentities });

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS user_identities (
        lid TEXT,
        pn TEXT,
        platform TEXT NOT NULL DEFAULT 'whatsapp',
        display_name TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS user_identities_lid_idx ON user_identities (lid);
      CREATE UNIQUE INDEX IF NOT EXISTS user_identities_pn_idx ON user_identities (pn);
    `);

    await db.delete(userIdentities);
  });

  afterEach(() => {
    IdentityService.setDepsForTesting(null);
    sqlite.close();
  });

  test('upsert with no lid and no pn does nothing', async () => {
    await IdentityService.upsert(undefined, undefined);

    const rows = await db.select().from(userIdentities);
    expect(rows).toHaveLength(0);
  });

  test('upsert with new identity inserts', async () => {
    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Test');

    const rows = await db.select().from(userIdentities);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lid).toBe('abc@lid');
    expect(rows[0]?.pn).toBe('123@s.whatsapp.net');
    expect(rows[0]?.displayName).toBe('Test');
  });

  test('upsert with existing identity updates', async () => {
    await db.insert(userIdentities).values({
      lid: 'abc@lid',
      pn: null,
      platform: 'whatsapp',
      displayName: null,
      updated_at: new Date('2024-01-01T00:00:00Z'),
    });

    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Test');

    const rows = await db.select().from(userIdentities);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lid).toBe('abc@lid');
    expect(rows[0]?.pn).toBe('123@s.whatsapp.net');
    expect(rows[0]?.displayName).toBe('Test');
  });

  test('upsert merges duplicate partial rows before updating canonical identity', async () => {
    await db.insert(userIdentities).values([
      {
        lid: 'abc@lid',
        pn: null,
        platform: 'whatsapp',
        displayName: null,
        updated_at: new Date('2024-01-01T00:00:00Z'),
      },
      {
        lid: null,
        pn: '123@s.whatsapp.net',
        platform: 'whatsapp',
        displayName: 'Test',
        updated_at: new Date('2024-01-01T00:00:00Z'),
      },
    ]);

    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Merged');

    const rows = await db.select().from(userIdentities);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lid).toBe('abc@lid');
    expect(rows[0]?.pn).toBe('123@s.whatsapp.net');
    expect(rows[0]?.displayName).toBe('Merged');
  });

  test('getAllJids with no mapping returns [jid]', async () => {
    const jids = await IdentityService.getAllJids('unknown@s.whatsapp.net');
    expect(jids).toEqual(['unknown@s.whatsapp.net']);
  });

  test('getAllJids with mapping returns all known JIDs', async () => {
    await db.insert(userIdentities).values({
      lid: 'abc@lid',
      pn: '123@s.whatsapp.net',
      platform: 'whatsapp',
      displayName: 'Test',
      updated_at: new Date('2024-01-01T00:00:00Z'),
    });

    const jids = await IdentityService.getAllJids('abc@lid');
    expect(jids).toContain('abc@lid');
    expect(jids).toContain('123@s.whatsapp.net');
  });

  test('getAllJids with empty string returns []', async () => {
    const jids = await IdentityService.getAllJids('');
    expect(jids).toEqual([]);
  });

  test('getPnForLid returns pn when found', async () => {
    await db.insert(userIdentities).values({
      lid: 'abc@lid',
      pn: '123@s.whatsapp.net',
      platform: 'whatsapp',
      displayName: 'Test',
      updated_at: new Date('2024-01-01T00:00:00Z'),
    });

    const pn = await IdentityService.getPnForLid('abc@lid');
    expect(pn).toBe('123@s.whatsapp.net');
  });

  test('getPnForLid returns undefined when not found', async () => {
    const pn = await IdentityService.getPnForLid('unknown@lid');
    expect(pn).toBeUndefined();
  });

  test('getLidForPn returns lid when found', async () => {
    await db.insert(userIdentities).values({
      lid: 'abc@lid',
      pn: '123@s.whatsapp.net',
      platform: 'whatsapp',
      displayName: 'Test',
      updated_at: new Date('2024-01-01T00:00:00Z'),
    });

    const lid = await IdentityService.getLidForPn('123@s.whatsapp.net');
    expect(lid).toBe('abc@lid');
  });

  test('getLidForPn returns undefined when not found', async () => {
    const lid = await IdentityService.getLidForPn('unknown@s.whatsapp.net');
    expect(lid).toBeUndefined();
  });

  test('getIdentity returns identity record when found', async () => {
    await db.insert(userIdentities).values({
      lid: 'abc@lid',
      pn: '123@s.whatsapp.net',
      platform: 'whatsapp',
      displayName: 'Test',
      updated_at: new Date('2024-01-01T00:00:00Z'),
    });

    const identity = await IdentityService.getIdentity('abc@lid');
    expect(identity).not.toBeNull();
    expect(identity!.lid).toBe('abc@lid');
    expect(identity!.pn).toBe('123@s.whatsapp.net');
    expect(identity!.displayName).toBe('Test');
    expect(identity!.platform).toBe('whatsapp');
  });

  test('getIdentity returns null when not found', async () => {
    const identity = await IdentityService.getIdentity('unknown@s.whatsapp.net');
    expect(identity).toBeNull();
  });

  test('getIdentity with LID JID queries correctly', async () => {
    await db.insert(userIdentities).values({
      lid: 'abc@lid',
      pn: '123@s.whatsapp.net',
      platform: 'whatsapp',
      displayName: 'LID User',
      updated_at: new Date('2024-01-01T00:00:00Z'),
    });

    const identity = await IdentityService.getIdentity('abc@lid');
    expect(identity).not.toBeNull();
    expect(identity!.lid).toBe('abc@lid');
  });
});
