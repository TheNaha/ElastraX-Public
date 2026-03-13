import { describe, test, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { userIdentities, userRoles } from '../src/db/schema';
import { IdentityService } from '../src/utils/IdentityService';
import { PrivilegeService } from '../src/utils/PrivilegeService';
import { RoleService, BUILTIN_ROLES } from '../src/utils/RoleService';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

describe('RoleService', () => {
  const savedOwnerJid = process.env.BOT_OWNER_JID;
  let sqlite: Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    IdentityService.setDepsForTesting({ db: db as typeof import('../src/db').db, userIdentities });
    RoleService.setDepsForTesting({ db: db as typeof import('../src/db').db, userRoles });

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS user_roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'whatsapp',
        scope TEXT NOT NULL DEFAULT 'global',
        role TEXT NOT NULL DEFAULT 'user',
        granted_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS user_roles_user_scope_idx ON user_roles (user_id, scope);
      CREATE INDEX IF NOT EXISTS user_roles_scope_idx ON user_roles (scope, role);

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

    await db.delete(userRoles).run();
    await db.delete(userIdentities).run();
    process.env.BOT_OWNER_JID = '';
  });

  afterEach(() => {
    process.env.BOT_OWNER_JID = savedOwnerJid;
    IdentityService.setDepsForTesting(null);
    RoleService.setDepsForTesting(null);
    sqlite.close();
  });

  test('BUILTIN_ROLES contains all expected roles', () => {
    expect(BUILTIN_ROLES).toContain('user');
    expect(BUILTIN_ROLES).toContain('premium');
    expect(BUILTIN_ROLES).toContain('admin');
    expect(BUILTIN_ROLES).toContain('owner');
  });

  test('hasPermission user always true', () => {
    expect(RoleService.hasPermission(['user'], 'user')).toBe(true);
  });

  test('hasPermission owner returns true for any required', () => {
    expect(RoleService.hasPermission(['owner'], 'admin')).toBe(true);
    expect(RoleService.hasPermission(['owner'], 'premium')).toBe(true);
  });

  test('hasPermission without required role returns false', () => {
    expect(RoleService.hasPermission(['user'], 'admin')).toBe(false);
  });

  test('resolveRoles returns at least user', async () => {
    const roles = await RoleService.resolveRoles('test-user');
    expect(roles).toContain('user');
  });

  test('resolveRoles with matching BOT_OWNER_JID adds owner', async () => {
    process.env.BOT_OWNER_JID = 'owner@s.whatsapp.net';
    const roles = await RoleService.resolveRoles('owner@s.whatsapp.net');
    expect(roles).toContain('owner');
  });

  test('resolveRoles with isPlatformAdmin adds admin', async () => {
    const roles = await RoleService.resolveRoles('user-1', 'chat-1', true);
    expect(roles).toContain('admin');
  });

  test('resolveRoles with DB roles adds them', async () => {
    await db.insert(userRoles).values({
      userId: 'user-1',
      platform: 'whatsapp',
      scope: 'global',
      role: 'premium',
      grantedBy: 'owner-1',
      created_at: new Date('2024-01-01T00:00:00Z'),
    });

    const roles = await RoleService.resolveRoles('user-1', 'chat-1');
    expect(roles).toContain('premium');
  });

  test('resolveRoles uses canonical identity when getAllJids returns a single mapped JID', async () => {
    const getAllJidsSpy = spyOn(IdentityService, 'getAllJids').mockResolvedValue(['canonical@s.whatsapp.net']);

    await db.insert(userRoles).values([
      {
        userId: 'canonical@s.whatsapp.net',
        platform: 'whatsapp',
        scope: 'global',
        role: 'premium',
        grantedBy: 'owner-1',
        created_at: new Date('2024-01-01T00:00:00Z'),
      },
      {
        userId: 'user@lid',
        platform: 'whatsapp',
        scope: 'global',
        role: 'admin',
        grantedBy: 'owner-1',
        created_at: new Date('2024-01-01T00:00:00Z'),
      },
    ]);

    const roles = await RoleService.resolveRoles('user@lid', 'chat-1');

    expect(roles).toContain('premium');
    expect(roles).not.toContain('admin');
    getAllJidsSpy.mockRestore();
  });

  test('getAccessProfile returns roles with merged privileges', async () => {
    const getEffectiveSpy = spyOn(PrivilegeService, 'getEffective').mockResolvedValue({
      maxMessagesPerWindow: 30,
      rateLimitWindowSec: 60,
      contextLimit: 50,
      maxDownloadMb: 100,
    });

    const profile = await RoleService.getAccessProfile(['user', 'premium']);

    expect(profile.roles).toEqual(['user', 'premium']);
    expect(profile.privileges.contextLimit).toBe(50);
    expect(getEffectiveSpy).toHaveBeenCalledWith(['user', 'premium']);

    getEffectiveSpy.mockRestore();
  });

  test('setRole calls insert for new role', async () => {
    await RoleService.setRole('user-1', 'admin', 'global', 'whatsapp', 'owner-1');

    const rows = await db.select().from(userRoles);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe('user-1');
    expect(rows[0]?.role).toBe('admin');
  });

  test('removeRole with no matching entry returns false', async () => {
    const result = await RoleService.removeRole('user-1', 'global', 'admin');
    expect(result).toBe(false);
  });

  test('removeRole with matching entry returns true', async () => {
    await db.insert(userRoles).values({
      userId: 'user-1',
      platform: 'whatsapp',
      scope: 'global',
      role: 'admin',
      grantedBy: 'owner-1',
      created_at: new Date('2024-01-01T00:00:00Z'),
    });

    const result = await RoleService.removeRole('user-1', 'global', 'admin');
    expect(result).toBe(true);

    const rows = await db.select().from(userRoles);
    expect(rows).toHaveLength(0);
  });

  test('getUserRoles uses canonical identity when getAllJids returns a single mapped JID', async () => {
    const getAllJidsSpy = spyOn(IdentityService, 'getAllJids').mockResolvedValue(['canonical@s.whatsapp.net']);

    await db.insert(userRoles).values([
      {
        userId: 'canonical@s.whatsapp.net',
        platform: 'whatsapp',
        scope: 'global',
        role: 'admin',
        grantedBy: 'owner-1',
        created_at: new Date('2024-01-01T00:00:00Z'),
      },
      {
        userId: 'user@lid',
        platform: 'whatsapp',
        scope: 'global',
        role: 'owner',
        grantedBy: 'owner-1',
        created_at: new Date('2024-01-01T00:00:00Z'),
      },
    ]);

    const roles = await RoleService.getUserRoles('user@lid');

    expect(roles).toEqual([{ scope: 'global', role: 'admin' }]);
    getAllJidsSpy.mockRestore();
  });

  test('meetsRequirement works correctly', () => {
    expect(RoleService.meetsRequirement('owner', 'admin')).toBe(true);
    expect(RoleService.meetsRequirement('user', 'admin')).toBe(false);
    expect(RoleService.meetsRequirement('admin', 'admin')).toBe(true);
  });
});
