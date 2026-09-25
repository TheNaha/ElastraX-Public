import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createTempDatabase, type TempDatabase } from './helpers/database';
import { canonicalIdentities, identityAliases, userIdentities, userRoles } from '../src/db/schema';
import { IdentityService } from '../src/utils/IdentityService';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

describe('IdentityService', () => {
  let database: TempDatabase;

  beforeEach(() => {
    database = createTempDatabase();
    IdentityService.setDepsForTesting({
      db: database.db,
      userIdentities,
      canonicalIdentities,
      identityAliases,
    });
  });

  afterEach(() => {
    IdentityService.setDepsForTesting(null);
    database.cleanup();
  });

  test('upsert with no lid and no pn does nothing', async () => {
    await IdentityService.upsert(undefined, undefined);

    const rows = await database.db.select().from(userIdentities);
    expect(rows).toHaveLength(0);
    expect(await database.db.select().from(canonicalIdentities)).toHaveLength(0);
    expect(await database.db.select().from(identityAliases)).toHaveLength(0);
  });

  test('upsert with new identity inserts canonical row, aliases, and legacy mapping', async () => {
    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Test');

    const rows = await database.db.select().from(userIdentities);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lid).toBe('abc@lid');
    expect(rows[0]?.pn).toBe('123@s.whatsapp.net');
    expect(rows[0]?.displayName).toBe('Test');
    expect(rows[0]?.platform).toBe('whatsapp');
    expect(rows[0]?.canonicalId).toBeTruthy();

    const canonical = await database.db.select().from(canonicalIdentities);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.platform).toBe('whatsapp');
    expect(canonical[0]?.displayName).toBe('Test');
    const canonicalId = canonical[0]!.id;
    expect(canonicalId).toBe(rows[0]!.canonicalId!);

    const aliases = await database.db.select().from(identityAliases);
    expect(aliases.map(row => row.alias).sort()).toEqual(['123@s.whatsapp.net', 'abc@lid']);
    expect(aliases.every(row => row.canonicalId === canonicalId)).toBe(true);
    expect(aliases.find(row => row.alias === 'abc@lid')?.aliasKind).toBe('lid');
    expect(aliases.find(row => row.alias === '123@s.whatsapp.net')?.aliasKind).toBe('pn');
  });

  test('upsert with existing lid-only identity extends the same canonical record with the phone alias', async () => {
    await IdentityService.upsert('abc@lid', null, null);

    const beforeUpsert = await IdentityService.getIdentity('abc@lid');
    expect(beforeUpsert).not.toBeNull();
    expect(beforeUpsert!.canonicalId).toBeTruthy();

    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Test');

    const afterUpsert = await IdentityService.getIdentity('abc@lid');
    expect(afterUpsert!.canonicalId).toBe(beforeUpsert!.canonicalId);
    expect(afterUpsert!.pn).toBe('123@s.whatsapp.net');
    expect(afterUpsert!.displayName).toBe('Test');

    const canonical = await database.db.select().from(canonicalIdentities);
    expect(canonical).toHaveLength(1);

    const aliases = await database.db.select().from(identityAliases);
    expect(aliases.map(row => row.alias).sort()).toEqual(['123@s.whatsapp.net', 'abc@lid']);
    expect(new Set(aliases.map(row => row.canonicalId)).size).toBe(1);

    const rows = await database.db.select().from(userIdentities);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lid).toBe('abc@lid');
    expect(rows[0]?.canonicalId).toBe(beforeUpsert!.canonicalId);
  });

  test('upsert merges duplicate partial rows into one canonical identity', async () => {
    await database.db.insert(userIdentities).values([
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

    const lidIdentity = await IdentityService.getIdentity('abc@lid');
    const pnIdentity = await IdentityService.getIdentity('123@s.whatsapp.net');
    expect(lidIdentity).not.toBeNull();
    expect(pnIdentity).not.toBeNull();
    expect(lidIdentity!.canonicalId).not.toBe(pnIdentity!.canonicalId);

    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Merged');

    const aliases = await database.db.select().from(identityAliases);
    const byAlias = new Map(aliases.map(row => [row.alias, row.canonicalId]));
    expect(byAlias.get('abc@lid')).toBe(byAlias.get('123@s.whatsapp.net'));

    const canonical = await database.db.select().from(canonicalIdentities);
    const merged = canonical.find(row => row.id === byAlias.get('abc@lid'));
    expect(merged?.displayName).toBe('Merged');

    const identity = await IdentityService.getIdentity('123@s.whatsapp.net');
    expect(identity!.lid).toBe('abc@lid');
    expect(identity!.displayName).toBe('Merged');
  });

  test('concurrent upserts of the same identity are serialized safely', async () => {
    const calls = Array.from({ length: 64 }, (_, index) => IdentityService.upsert(
      'race@lid',
      'race@s.whatsapp.net',
      `Race ${index}`,
    ));
    await expect(Promise.all(calls)).resolves.toBeDefined();

    const canonical = await database.db.select().from(canonicalIdentities);
    expect(canonical).toHaveLength(1);
    const aliases = await database.db.select().from(identityAliases);
    expect(aliases).toHaveLength(2);
    expect(new Set(aliases.map(row => row.canonicalId)).size).toBe(1);
    expect(await database.db.select().from(userIdentities)).toHaveLength(1);
  });

  test('upsert keeps platforms isolated for the same alias', async () => {
    await IdentityService.upsertIdentity(null, 'shared@example.com', 'WhatsApp', 'whatsapp');
    await IdentityService.upsertIdentity(null, 'shared@example.com', 'Discord', 'discord');

    const canonical = await database.db.select().from(canonicalIdentities);
    expect(canonical).toHaveLength(2);
    expect(canonical.map(row => row.platform).sort()).toEqual(['discord', 'whatsapp']);

    const identity = await IdentityService.getIdentity('shared@example.com');
    expect(identity?.platform).toBe('discord');
    expect(identity?.displayName).toBe('Discord');
  });

  test('getAllJids with no mapping returns [jid]', async () => {
    const jids = await IdentityService.getAllJids('unknown@s.whatsapp.net');
    expect(jids).toEqual(['unknown@s.whatsapp.net']);
  });

  test('getAllJids with mapping returns all known JIDs', async () => {
    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Test');

    const jids = await IdentityService.getAllJids('abc@lid');
    expect(jids).toContain('abc@lid');
    expect(jids).toContain('123@s.whatsapp.net');
  });

  test('getAllJids with empty string returns []', async () => {
    const jids = await IdentityService.getAllJids('');
    expect(jids).toEqual([]);
  });

  test('getPnForLid returns pn when found', async () => {
    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Test');

    const pn = await IdentityService.getPnForLid('abc@lid');
    expect(pn).toBe('123@s.whatsapp.net');
  });

  test('getPnForLid returns undefined when not found', async () => {
    const pn = await IdentityService.getPnForLid('unknown@lid');
    expect(pn).toBeUndefined();
  });

  test('getLidForPn returns lid when found', async () => {
    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Test');

    const lid = await IdentityService.getLidForPn('123@s.whatsapp.net');
    expect(lid).toBe('abc@lid');
  });

  test('getLidForPn returns undefined when not found', async () => {
    const lid = await IdentityService.getLidForPn('unknown@s.whatsapp.net');
    expect(lid).toBeUndefined();
  });

  test('getIdentity returns identity record when found', async () => {
    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Test');

    const identity = await IdentityService.getIdentity('abc@lid');
    expect(identity).not.toBeNull();
    expect(identity!.lid).toBe('abc@lid');
    expect(identity!.pn).toBe('123@s.whatsapp.net');
    expect(identity!.displayName).toBe('Test');
    expect(identity!.platform).toBe('whatsapp');
    expect(identity!.canonicalId).toBeTruthy();
  });

  test('getIdentity returns null when not found', async () => {
    const identity = await IdentityService.getIdentity('unknown@s.whatsapp.net');
    expect(identity).toBeNull();
  });

  test('getIdentity with LID JID queries correctly', async () => {
    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'LID User');

    const identity = await IdentityService.getIdentity('abc@lid');
    expect(identity).not.toBeNull();
    expect(identity!.lid).toBe('abc@lid');
    expect(identity!.displayName).toBe('LID User');
  });

  test('setDisplayName updates the canonical record for every alias', async () => {
    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Test');

    await IdentityService.setDisplayName('abc@lid', 'Renamed');

    const canonical = await database.db.select().from(canonicalIdentities);
    expect(canonical[0]?.displayName).toBe('Renamed');
    const rows = await database.db.select().from(userIdentities);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe('Renamed');
  });

  test('getIdentity resolves the phone alias created by the identity migration backfill', async () => {
    await database.db.insert(userIdentities).values({
      lid: 'migrated@lid',
      pn: '999@s.whatsapp.net',
      platform: 'whatsapp',
      displayName: 'Migrated',
      updated_at: new Date('2024-01-01T00:00:00Z'),
    });
    const backfilled = await database.db.select().from(identityAliases)
      .where(eq(identityAliases.alias, '999@s.whatsapp.net'));
    expect(backfilled).toHaveLength(1);

    const identity = await IdentityService.getIdentity('migrated@lid');
    expect(identity).not.toBeNull();
    expect(identity!.pn).toBe('999@s.whatsapp.net');
    expect(await IdentityService.getPnForLid('migrated@lid')).toBe('999@s.whatsapp.net');
  });

  test('clearUserIdentities removes aliases and legacy rows for a known JID', async () => {
    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Test');
    const identity = await IdentityService.getIdentity('abc@lid');
    expect(identity).not.toBeNull();

    await IdentityService.clearUserIdentities('abc@lid');

    expect(await database.db.select().from(identityAliases)).toHaveLength(0);
    expect(await database.db.select().from(userIdentities)).toHaveLength(0);
    expect(await IdentityService.getIdentity('abc@lid')).toBeNull();
  });

  test('getJidsAndRoles filters roles by platform and scope', async () => {
    await IdentityService.upsert('abc@lid', '123@s.whatsapp.net', 'Test');
    const identity = await IdentityService.getIdentity('abc@lid');
    const userId = identity!.canonicalId;

    await database.db.insert(userRoles).values([
      { userId, scope: 'global', role: 'admin', platform: 'whatsapp', grantedBy: 'owner', created_at: new Date() },
      { userId, scope: 'room-1', role: 'moderator', platform: 'whatsapp', grantedBy: 'owner', created_at: new Date() },
      { userId, scope: 'global', role: 'admin', platform: 'discord', grantedBy: 'owner', created_at: new Date() },
    ]);

    const global = await IdentityService.getJidsAndRoles(userId, undefined, 'whatsapp');
    expect(global.roles).toEqual([{ scope: 'global', role: 'admin' }]);

    const scoped = await IdentityService.getJidsAndRoles(userId, 'room-1', 'whatsapp');
    expect(scoped.roles.map(row => row.scope).sort()).toEqual(['global', 'room-1']);

    const otherPlatform = await IdentityService.getJidsAndRoles(userId, undefined, 'discord');
    expect(otherPlatform.roles).toEqual([{ scope: 'global', role: 'admin' }]);
  });

  test('upsert without canonical tables falls back to the legacy row update path', async () => {
    IdentityService.setDepsForTesting({ db: database.db, userIdentities, canonicalIdentities: undefined, identityAliases: undefined });

    await IdentityService.upsert('legacy@lid', null, 'Legacy');

    await IdentityService.upsert('legacy@lid', '555@s.whatsapp.net', 'Merged');

    const rows = await database.db.select().from(userIdentities);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lid).toBe('legacy@lid');
    expect(rows[0]?.pn).toBe('555@s.whatsapp.net');
    expect(rows[0]?.displayName).toBe('Merged');
    expect(await database.db.select().from(canonicalIdentities).where(eq(canonicalIdentities.displayName, 'Merged'))).toHaveLength(0);
  });
});
