import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';

type SafeDbQuery = {
  where: () => {
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise<unknown>;
    catch: (reject: (reason: unknown) => unknown) => Promise<unknown>;
    limit: () => Promise<unknown[]>;
    orderBy: () => { limit: () => Promise<unknown[]> };
  };
  limit: () => Promise<unknown[]>;
};

type SafeDb = {
  select: () => { from: () => SafeDbQuery };
  insert: () => { values: () => { onConflictDoNothing: () => Promise<object>; then: (resolve: (value: object) => unknown) => Promise<unknown> } };
  update: () => { set: () => { where: () => Promise<void> } };
  delete: () => { where: () => Promise<object> };
};

// ─── Override the db mock that leaks from agent.test.ts (mock.module is process-scoped) ───
// agent.test.ts permanently replaces '../src/db' without a `delete` method, which
// breaks code paths that call db.delete() even when most service methods are spied.
// This re-registers a safe, complete mock that covers all db operations used by
// RoleTool's service dependencies (RoleService, IdentityService, PrivilegeService).
mock.module('../src/db', () => {
  const safeMock: SafeDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (
            resolve: (value: unknown[]) => unknown,
            reject?: (reason: unknown) => unknown,
          ) => Promise.resolve([]).then(resolve, reject),
          catch: (reject: (reason: unknown) => unknown) => Promise.resolve([]).catch(reject),
          limit: () => Promise.resolve([]),
          orderBy: () => ({ limit: () => Promise.resolve([]) }),
        }),
        limit: () => Promise.resolve([]),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: async () => ({}),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({}).then(resolve),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => {} }),
    }),
    delete: () => ({
      where: async () => ({}),
    }),
  };
  return { db: safeMock };
});

import { MessageContext } from '../src/core/MessageContext';
import { RoleTool } from '../src/tools/RoleTool';
import { AuthService, BUILTIN_ROLES } from '../src/utils/AuthService';

import { IdentityService } from '../src/utils/IdentityService';

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'user-1@s.whatsapp.net',
  senderName: 'User',
  text: '',
  isGroup: false,
  isBotMentioned: false,
  hasMedia: false,
  language: 'en',
  messageType: 'conversation',
  messageId: 'msg-1',
  mediaReady: Promise.resolve(),
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  resolveRoles: mock(async () => ['user']),
  rawMessage: {},
  ...overrides,
} as MessageContext);

describe('RoleTool', () => {
  const tool = new RoleTool();
  const spies: Array<ReturnType<typeof spyOn>> = [];
  let listRolesSpy: ReturnType<typeof spyOn>;
  let accessProfileSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // spy on service methods
    spies.push(spyOn(AuthService, 'getUserRoles').mockResolvedValue([]));
    accessProfileSpy = spyOn(AuthService, 'getAccessProfile').mockResolvedValue({
      roles: ['user'],
      privileges: { maxMessagesPerWindow: 10, rateLimitWindowSec: 60, contextLimit: 20, maxDownloadMb: 25 },
    });
    spies.push(accessProfileSpy);
    listRolesSpy = spyOn(AuthService, 'listRoles').mockResolvedValue([]);
    spies.push(listRolesSpy);
    spies.push(spyOn(AuthService, 'setRole').mockResolvedValue(undefined));
    spies.push(spyOn(AuthService, 'removeRole').mockResolvedValue(true));
    spies.push(spyOn(AuthService, 'getEffectivePrivileges').mockResolvedValue({ maxMessagesPerWindow: 10, rateLimitWindowSec: 60, contextLimit: 20, maxDownloadMb: 25 }));
    spies.push(spyOn(AuthService, 'getPrivilegesForRole').mockResolvedValue({ maxMessagesPerWindow: 10, rateLimitWindowSec: 60, contextLimit: 20, maxDownloadMb: 25 }));
    spies.push(spyOn(AuthService, 'getDefaultPrivileges').mockReturnValue({ maxMessagesPerWindow: 10, rateLimitWindowSec: 60, contextLimit: 20, maxDownloadMb: 25 }));
    spies.push(spyOn(AuthService, 'setPrivilegeOverride').mockResolvedValue(undefined));
    spies.push(spyOn(AuthService, 'resetPrivilegesToDefaults').mockResolvedValue(undefined));
    spies.push(spyOn(IdentityService, 'getIdentity').mockImplementation(async () => null));
    spies.push(spyOn(IdentityService, 'getAllJids').mockImplementation(async (jid: string) => [jid]));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
  });

  test('basic properties', () => {
    expect(tool.name).toBe('role');
    expect(tool.aliases).toContain('roles');
    expect(tool.aliases).toContain('permission');
    expect(tool.aliases).toContain('perm');
    expect(tool.category).toBe('admin');
    expect(tool.permissions).toBe('user');
  });

  test('action=check returns roles and privileges for sender', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'check' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('Role info');
    expect(text).toContain('*`user`*');
    expect(AuthService.getAccessProfile).toHaveBeenCalledWith(['user']);
  });

  test('action=list with empty list returns list_empty', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'list' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('No roles assigned');
  });

  test('action=list with roles returns formatted list', async () => {
    listRolesSpy.mockResolvedValue([
      { userId: '628123@s.whatsapp.net', role: 'admin', scope: 'chat-1', grantedBy: 'owner@s.whatsapp.net' },
    ]);
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'list' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('*`admin`*');
  });

  test('action=privs returns privilege details', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'privs', role: 'user' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('Privileges');
    expect(text).toContain('maxMessagesPerWindow');
  });

  test('action=grant without user returns error', async () => {
    const ctx = createMockCtx({ resolveRoles: mock(async () => ['admin']) });
    const result = await tool.execute({ action: 'grant', role: 'premium' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('specify a user');
  });

  test('action=grant with valid user and admin caller works', async () => {
    const ctx = createMockCtx({
      resolveRoles: mock(async () => ['admin']),
      mentionedIds: ['628999@s.whatsapp.net'],
    });
    const result = await tool.execute({ action: 'grant', user: 'mentioned', role: 'premium' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('Granted');
    expect(AuthService.setRole).toHaveBeenCalled();
  });

  test('action=revoke removes role', async () => {
    const ctx = createMockCtx({
      resolveRoles: mock(async () => ['admin']),
      mentionedIds: ['628999@s.whatsapp.net'],
    });
    const result = await tool.execute({ action: 'revoke', user: 'mentioned', role: 'user' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('Revoked');
    expect(AuthService.removeRole).toHaveBeenCalled();
  });

  test('action=setpriv requires owner (rejects non-owner)', async () => {
    const ctx = createMockCtx({ resolveRoles: mock(async () => ['user']) });
    const result = await tool.execute({ action: 'setpriv', role: 'premium', field: 'contextLimit', value: '50' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('cannot assign');
  });

  test('action=setpriv with owner updates privilege override', async () => {
    accessProfileSpy.mockResolvedValue({
      roles: ['owner'],
      privileges: { maxMessagesPerWindow: -1, rateLimitWindowSec: 60, contextLimit: 100, maxDownloadMb: -1 },
    });
    const ctx = createMockCtx({ resolveRoles: mock(async () => ['owner']) });
    const result = await tool.execute({ action: 'setpriv', role: 'premium', field: 'contextLimit', value: '50' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('Set *contextLimit*');
    expect(AuthService.setPrivilegeOverride).toHaveBeenCalledWith('premium', 'contextLimit', 50);
  });

  test('action=resetpriv with owner clears privilege overrides', async () => {
    accessProfileSpy.mockResolvedValue({
      roles: ['owner'],
      privileges: { maxMessagesPerWindow: -1, rateLimitWindowSec: 60, contextLimit: 100, maxDownloadMb: -1 },
    });
    const ctx = createMockCtx({ resolveRoles: mock(async () => ['owner']) });
    const result = await tool.execute({ action: 'resetpriv', role: 'premium' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('reset to defaults');
    expect(AuthService.resetPrivilegesToDefaults).toHaveBeenCalledWith('premium');
  });
});
