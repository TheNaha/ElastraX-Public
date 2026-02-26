import { expect, test, describe, beforeEach, afterEach } from 'bun:test';
import { checkPermissions } from '../src/utils/permissions';

// Mock logger to suppress errors in test output
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => mockLogger,
};

// Mock module requires manual mock setup or dependency injection.
// Since checkPermissions imports logger directly, we rely on bun test runner environment
// or just let it log. For cleanliness, we might want to mock it but Bun mocking of modules
// is a bit different. Let's assume it's fine for now as logger is just side effect.

describe('checkPermissions', () => {
  let mockSock: any;
  const chatId = '1234567890@g.us';
  const senderId = '0987654321@s.whatsapp.net';

  beforeEach(() => {
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

  test('should return true for admin permission in private chat', async () => {
    const result = await checkPermissions(mockSock, 'privateChatId', senderId, false, 'admin');
    expect(result).toBe(true);
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
    const result = await checkPermissions(mockSock, chatId, senderId, true, 'admin');
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

  test('should return false for an unrecognised required level', async () => {
    // TypeScript prevents this but we test the runtime fallback for full line coverage
    const result = await checkPermissions(mockSock, chatId, senderId, false, 'superuser' as any);
    expect(result).toBe(false);
  });
});
