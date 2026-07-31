import { expect, test, describe, beforeEach, afterEach, mock } from 'bun:test';
import { IdentityService } from '../src/utils/IdentityService';
import { AuthService as RoleService } from '../src/utils/AuthService';
import { userIdentities, userRoles } from '../src/db/schema';

type MockQuery = {
  from: () => MockQuery;
  where: () => MockQuery;
  limit: () => MockQuery;
  then: (resolve: (value: unknown[]) => unknown) => unknown;
};

type MockParticipant = {
  id: string;
  admin: 'admin' | 'superadmin' | null;
};

type MockGroupMetadataSock = {
  groupMetadata: (jid: string) => Promise<{ participants: MockParticipant[] }>;
};

// Mock DB to return no stored roles (prevents hanging on real SQLite queries).
// Tests control behaviour entirely through env vars & platform admin detection.
const mockDbRows: unknown[] = [];

/** Creates a chainable mock query object that returns mockDbRows. */
function mockQuery(): MockQuery {
  const obj: MockQuery = {
    from: () => obj,
    where: () => obj,
    limit: () => obj,
    then: (resolve) => resolve(mockDbRows),
  };
  return obj;
}

mock.module('../src/utils/logger', () => ({
  logger: {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => ({
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
  },
}));

import { checkPermissions } from '../src/utils/permissions';

describe('checkPermissions', () => {
  let mockSock: MockGroupMetadataSock;
  const chatId = '1234567890@g.us';
  const senderId = '0987654321@s.whatsapp.net';
  const mockDb = {
    select: () => mockQuery(),
  } as unknown as typeof import('../src/db').db;

  beforeEach(() => {
    IdentityService.setDepsForTesting({ db: mockDb, userIdentities });
    RoleService.setDepsForTesting({ db: mockDb, userRoles });
    mockSock = {
      groupMetadata: async (jid: string) => {
        if (jid === chatId) {
          return {
            participants: [
              { id: senderId, admin: 'admin' },
              { id: 'other@s.whatsapp.net', admin: null },
              { id: 'super@s.whatsapp.net', admin: 'superadmin' }
            ]
          };
        }
        throw new Error('Group not found');
      }
    };
    process.env.BOT_OWNER_JID = 'owner@s.whatsapp.net';
  });

  afterEach(() => {
    IdentityService.setDepsForTesting(null);
    RoleService.setDepsForTesting(null);
    delete process.env.BOT_OWNER_JID;
  });

  test('should return true for user permission', async () => {
    const result = await checkPermissions(mockSock, chatId, senderId, true, 'user');
    expect(result).toBe(true);
  });

  test('should return true for owner permission if sender matches env var', async () => {
    const result = await checkPermissions(mockSock, chatId, 'owner@s.whatsapp.net', true, 'owner');
    expect(result).toBe(true);
  });

  test('should return false for owner permission if sender does not match env var', async () => {
    const result = await checkPermissions(mockSock, chatId, senderId, true, 'owner');
    expect(result).toBe(false);
  });

  test('should return false for owner permission if BOT_OWNER_JID is not configured', async () => {
    const originalEnv = process.env.BOT_OWNER_JID;
    delete process.env.BOT_OWNER_JID;
    try {
      // We try to check permissions for a user that IS the owner (if configured)
      // but since config is missing, it should fail.
      const result = await checkPermissions(mockSock, chatId, 'owner@s.whatsapp.net', true, 'owner');
      expect(result).toBe(false);
    } finally {
      process.env.BOT_OWNER_JID = originalEnv;
    }
  });

  test('should return false for admin permission in private chat (set-based model)', async () => {
    // V7.11: admin is an explicit role, no longer auto-granted in private chats
    const result = await checkPermissions(mockSock, 'privateChatId', senderId, false, 'admin');
    expect(result).toBe(false);
  });

  test('should return true for admin permission in group chat if user is admin', async () => {
    const result = await checkPermissions(mockSock, chatId, senderId, true, 'admin');
    expect(result).toBe(true);
  });

  test('should return true for admin permission in group chat if user is superadmin', async () => {
    const result = await checkPermissions(mockSock, chatId, 'super@s.whatsapp.net', true, 'admin');
    expect(result).toBe(true);
  });

  test('should return false for admin permission in group chat if user is not admin', async () => {
    const result = await checkPermissions(mockSock, chatId, 'other@s.whatsapp.net', true, 'admin');
    expect(result).toBe(false);
  });

  test('should return false if group metadata fetch fails', async () => {
    mockSock.groupMetadata = async () => { throw new Error('Failed'); };
    const result = await checkPermissions(mockSock, 'uncached-chat', senderId, true, 'admin');
    expect(result).toBe(false);
  });

  test('should return false for admin permission in group when sock is null', async () => {
    const result = await checkPermissions(null, chatId, senderId, true, 'admin');
    expect(result).toBe(false);
  });

  test('should return false when participant is not found in group metadata', async () => {
    const result = await checkPermissions(mockSock, chatId, 'unknown@s.whatsapp.net', true, 'admin');
    expect(result).toBe(false);
  });

  test('should match admin permissions through senderPn when senderId is a lid jid', async () => {
    const result = await checkPermissions(
      mockSock,
      chatId,
      'user-lid@lid',
      true,
      'admin',
      senderId,
    );
    expect(result).toBe(true);
  });

  test('should return false for an unrecognised required level', async () => {
    // TypeScript prevents this but we test the runtime fallback for full line coverage
    const result = await checkPermissions(mockSock, chatId, senderId, false, 'superuser' as never);
    expect(result).toBe(false);
  });
});
