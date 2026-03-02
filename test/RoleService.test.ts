import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

let mockRoleRows: any[] = [];
let lastInsertedRole: any = null;
let lastDeletedCond: any = false;

import { IdentityService } from '../src/utils/IdentityService';

/** Creates a chainable thenable mock query that resolves to mockRoleRows. */
function mockQuery() {
  const obj: any = {
    from: () => obj,
    where: () => obj,
    limit: () => obj,
    then: (resolve: any) => resolve(mockRoleRows),
  };
  return obj;
}

mock.module('../src/db', () => ({
  db: {
    select: () => mockQuery(),
    insert: () => ({
      values: (vals: any) => {
        lastInsertedRole = vals;
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
    delete: () => ({
      where: () => {
        lastDeletedCond = true;
        return Promise.resolve();
      },
    }),
  },
}));

import { RoleService, BUILTIN_ROLES } from '../src/utils/RoleService';

describe('RoleService', () => {
  const savedOwnerJid = process.env.BOT_OWNER_JID;

  beforeEach(() => {
    mockRoleRows = [];
    lastInsertedRole = null;
    lastDeletedCond = false;
    process.env.BOT_OWNER_JID = '';
    spyOn(IdentityService, 'getAllJids').mockImplementation(async (jid: string) => [jid]);
  });

  afterEach(() => {
    process.env.BOT_OWNER_JID = savedOwnerJid;
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
    mockRoleRows = [{ scope: 'global', role: 'premium' }];
    const roles = await RoleService.resolveRoles('user-1', 'chat-1');
    expect(roles).toContain('premium');
  });

  test('setRole calls insert for new role', async () => {
    mockRoleRows = [];
    await RoleService.setRole('user-1', 'admin', 'global', 'whatsapp', 'owner-1');
    expect(lastInsertedRole).toBeDefined();
    expect(lastInsertedRole.role).toBe('admin');
  });

  test('removeRole with no matching entry returns false', async () => {
    mockRoleRows = [];
    const result = await RoleService.removeRole('user-1', 'global', 'admin');
    expect(result).toBe(false);
  });

  test('removeRole with matching entry returns true', async () => {
    mockRoleRows = [{ id: 1 }];
    const result = await RoleService.removeRole('user-1', 'global', 'admin');
    expect(result).toBe(true);
  });

  test('meetsRequirement works correctly', () => {
    expect(RoleService.meetsRequirement('owner', 'admin')).toBe(true);
    expect(RoleService.meetsRequirement('user', 'admin')).toBe(false);
    expect(RoleService.meetsRequirement('admin', 'admin')).toBe(true);
  });
});
