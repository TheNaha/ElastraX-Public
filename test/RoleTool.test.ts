import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

const mockGetUserRoles = mock(async () => [] as any[]);
const mockListRoles = mock(async () => [] as any[]);
const mockSetRole = mock(async () => {});
const mockRemoveRole = mock(async () => true);
const mockGetEffective = mock(async () => ({ maxMessagesPerWindow: 10, rateLimitWindowSec: 60, contextLimit: 20, maxDownloadMb: 25 }));
const mockGetForRole = mock(async () => ({ maxMessagesPerWindow: 10, rateLimitWindowSec: 60, contextLimit: 20, maxDownloadMb: 25 }));
const mockGetDefaults = mock(() => ({ maxMessagesPerWindow: 10, rateLimitWindowSec: 60, contextLimit: 20, maxDownloadMb: 25 }));
const mockGetIdentity = mock(async () => null);

mock.module('../src/utils/RoleService', () => ({
  RoleService: {
    getUserRoles: mockGetUserRoles,
    listRoles: mockListRoles,
    setRole: mockSetRole,
    removeRole: mockRemoveRole,
    resolveRoles: mock(async () => ['user']),
  },
  BUILTIN_ROLES: ['user', 'premium', 'admin', 'owner'],
}));

mock.module('../src/utils/PrivilegeService', () => ({
  PrivilegeService: {
    getEffective: mockGetEffective,
    getForRole: mockGetForRole,
    getDefaults: mockGetDefaults,
    setOverride: mock(async () => {}),
    resetToDefaults: mock(async () => {}),
  },
}));

mock.module('../src/utils/IdentityService', () => ({
  IdentityService: {
    getIdentity: mockGetIdentity,
    getAllJids: mock(async (jid: string) => [jid]),
  },
}));

// Mock the DB for any transitive imports
mock.module('../src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          all: () => [],
          orderBy: () => ({ all: () => [] }),
        }),
        all: () => [],
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => ({}), run: () => {} }) }),
    delete: () => ({ where: () => ({ run: () => {} }) }),
  },
}));

import { RoleTool } from '../src/tools/RoleTool';

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'user-1@s.whatsapp.net',
  senderName: 'User',
  text: '',
  isGroup: false,
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

beforeEach(() => {
  mockGetUserRoles.mockReset();
  mockGetUserRoles.mockImplementation(async () => []);
  mockListRoles.mockReset();
  mockListRoles.mockImplementation(async () => []);
  mockSetRole.mockReset();
  mockRemoveRole.mockReset();
  mockRemoveRole.mockImplementation(async () => true);
  mockGetEffective.mockReset();
  mockGetEffective.mockImplementation(async () => ({ maxMessagesPerWindow: 10, rateLimitWindowSec: 60, contextLimit: 20, maxDownloadMb: 25 }));
  mockGetForRole.mockReset();
  mockGetForRole.mockImplementation(async () => ({ maxMessagesPerWindow: 10, rateLimitWindowSec: 60, contextLimit: 20, maxDownloadMb: 25 }));
  mockGetDefaults.mockReset();
  mockGetDefaults.mockImplementation(() => ({ maxMessagesPerWindow: 10, rateLimitWindowSec: 60, contextLimit: 20, maxDownloadMb: 25 }));
  mockGetIdentity.mockReset();
  mockGetIdentity.mockImplementation(async () => null);
});

describe('RoleTool', () => {
  const tool = new RoleTool();

  test('basic properties', () => {
    expect(tool.name).toBe('role');
    expect(tool.aliases).toContain('roles');
    expect(tool.aliases).toContain('permission');
    expect(tool.aliases).toContain('perm');
    expect(tool.category).toBe('admin');
    expect(tool.permissions).toBe('user');
  });

  test('action=check returns roles and privileges for sender', async () => {
    mockGetUserRoles.mockImplementation(async () => []);
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'check' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('Role info');
    expect(text).toContain('user');
  });

  test('action=list with empty list returns list_empty', async () => {
    mockListRoles.mockImplementation(async () => []);
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'list' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('No roles assigned');
  });

  test('action=list with roles returns formatted list', async () => {
    mockListRoles.mockImplementation(async () => [
      { userId: '628123@s.whatsapp.net', role: 'admin', scope: 'chat-1', grantedBy: 'owner@s.whatsapp.net' },
    ]);
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'list' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('admin');
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
    expect(mockSetRole).toHaveBeenCalled();
  });

  test('action=revoke removes role', async () => {
    const ctx = createMockCtx({
      resolveRoles: mock(async () => ['admin']),
      mentionedIds: ['628999@s.whatsapp.net'],
    });
    const result = await tool.execute({ action: 'revoke', user: 'mentioned', role: 'user' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('Revoked');
    expect(mockRemoveRole).toHaveBeenCalled();
  });

  test('action=setpriv requires owner (rejects non-owner)', async () => {
    const ctx = createMockCtx({ resolveRoles: mock(async () => ['user']) });
    const result = await tool.execute({ action: 'setpriv', role: 'premium', field: 'contextLimit', value: '50' }, ctx);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('cannot assign');
  });
});
