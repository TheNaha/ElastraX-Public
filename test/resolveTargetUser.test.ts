import { describe, test, expect } from 'bun:test';
import { resolveTargetUser, resolveAllTargetUsers } from '../src/utils/resolveTargetUser';
import type { MessageContext } from '../src/core/MessageContext';

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'user@s.whatsapp.net',
  senderName: 'User',
  text: '',
  isGroup: true,
  hasMedia: false,
  rawMessage: {},
  messageType: 'conversation',
  messageId: 'msg-1',
  mediaReady: Promise.resolve(),
  reply: async () => {},
  checkPermissions: async () => true,
  resolveRoles: async () => ['user'],
  ...overrides,
} as MessageContext);

describe('resolveTargetUser', () => {
  test('sentinel "mentioned" with mentionedIds returns first mention', () => {
    const ctx = createMockCtx({ mentionedIds: ['628111@s.whatsapp.net', '628222@s.whatsapp.net'] });
    const result = resolveTargetUser({ user: 'mentioned' }, ctx);
    expect(result).not.toBeNull();
    expect(result!.jid).toBe('628111@s.whatsapp.net');
    expect(result!.source).toBe('mention');
  });

  test('sentinel "mentioned" with no mentions returns null', () => {
    const ctx = createMockCtx({ mentionedIds: [] });
    const result = resolveTargetUser({ user: 'mentioned' }, ctx);
    expect(result).toBeNull();
  });

  test('sentinel "quoted" with quoted.senderId returns quoted sender', () => {
    const ctx = createMockCtx({
      quoted: {
        messageType: 'conversation',
        body: 'hello',
        text: 'hello',
        senderId: '628333@s.whatsapp.net',
        hasMedia: false,
        rawMessage: {},
      },
    });
    const result = resolveTargetUser({ user: 'quoted' }, ctx);
    expect(result).not.toBeNull();
    expect(result!.jid).toBe('628333@s.whatsapp.net');
    expect(result!.source).toBe('quoted');
  });

  test('sentinel "quoted" with no quoted returns null', () => {
    const ctx = createMockCtx();
    const result = resolveTargetUser({ user: 'quoted' }, ctx);
    expect(result).toBeNull();
  });

  test('explicit JID (contains @) returns it directly', () => {
    const ctx = createMockCtx();
    const result = resolveTargetUser({ user: '628444@s.whatsapp.net' }, ctx);
    expect(result).not.toBeNull();
    expect(result!.jid).toBe('628444@s.whatsapp.net');
    expect(result!.source).toBe('jid');
  });

  test('explicit LID (ends with @lid) returns with source lid', () => {
    const ctx = createMockCtx();
    const result = resolveTargetUser({ user: '12345@lid' }, ctx);
    expect(result).not.toBeNull();
    expect(result!.jid).toBe('12345@lid');
    expect(result!.source).toBe('lid');
  });

  test('phone number (pure digits) converts to JID with @s.whatsapp.net', () => {
    const ctx = createMockCtx();
    const result = resolveTargetUser({ user: '628123456789' }, ctx);
    expect(result).not.toBeNull();
    expect(result!.jid).toBe('628123456789@s.whatsapp.net');
    expect(result!.source).toBe('phone');
  });

  test('phone starting with 0 (Indonesian) prepends 62', () => {
    const ctx = createMockCtx();
    const result = resolveTargetUser({ user: '0812345678' }, ctx);
    expect(result).not.toBeNull();
    expect(result!.jid).toBe('62812345678@s.whatsapp.net');
    expect(result!.source).toBe('phone');
  });

  test('empty arg falls back to contextual: mention > quote', () => {
    const ctx = createMockCtx({ mentionedIds: ['628555@s.whatsapp.net'] });
    const result = resolveTargetUser({ user: '' }, ctx);
    expect(result).not.toBeNull();
    expect(result!.jid).toBe('628555@s.whatsapp.net');
    expect(result!.source).toBe('mention');
  });

  test('empty arg with no mention falls back to quote', () => {
    const ctx = createMockCtx({
      quoted: {
        messageType: 'conversation',
        body: 'hi',
        text: 'hi',
        senderId: '628666@s.whatsapp.net',
        hasMedia: false,
        rawMessage: {},
      },
    });
    const result = resolveTargetUser({ user: '' }, ctx);
    expect(result).not.toBeNull();
    expect(result!.jid).toBe('628666@s.whatsapp.net');
    expect(result!.source).toBe('quoted');
  });

  test('empty arg with no mention or quote returns null', () => {
    const ctx = createMockCtx();
    const result = resolveTargetUser({ user: '' }, ctx);
    expect(result).toBeNull();
  });

  test('short non-JID non-digit string (<=5 chars) returns null', () => {
    const ctx = createMockCtx();
    const result = resolveTargetUser({ user: 'abc' }, ctx);
    expect(result).toBeNull();
  });

  test('long non-JID non-digit string (>5 chars) with digits is treated as phone', () => {
    const ctx = createMockCtx();
    // isPureDigits strips non-digits before checking, so 'someuser123' → '123' → phone
    const result = resolveTargetUser({ user: 'someuser123' }, ctx);
    expect(result).not.toBeNull();
    expect(result!.jid).toBe('123@s.whatsapp.net');
    expect(result!.source).toBe('phone');
  });

  test('long non-JID purely alpha string (>5 chars) returns with source jid', () => {
    const ctx = createMockCtx();
    const result = resolveTargetUser({ user: 'someuserhandle' }, ctx);
    expect(result).not.toBeNull();
    expect(result!.jid).toBe('someuserhandle');
    expect(result!.source).toBe('jid');
  });
});

describe('resolveAllTargetUsers', () => {
  test('multiple mentionedIds returns all', () => {
    const ctx = createMockCtx({
      mentionedIds: ['628111@s.whatsapp.net', '628222@s.whatsapp.net', '628333@s.whatsapp.net'],
    });
    const results = resolveAllTargetUsers({}, ctx);
    expect(results).toHaveLength(3);
    expect(results[0].jid).toBe('628111@s.whatsapp.net');
    expect(results[1].jid).toBe('628222@s.whatsapp.net');
    expect(results[2].jid).toBe('628333@s.whatsapp.net');
    results.forEach(r => expect(r.source).toBe('mention'));
  });

  test('single target falls back to resolveTargetUser', () => {
    const ctx = createMockCtx({ mentionedIds: ['628111@s.whatsapp.net'] });
    const results = resolveAllTargetUsers({ user: '628444@s.whatsapp.net' }, ctx);
    expect(results).toHaveLength(1);
    expect(results[0].jid).toBe('628444@s.whatsapp.net');
  });

  test('no targets returns empty array', () => {
    const ctx = createMockCtx();
    const results = resolveAllTargetUsers({}, ctx);
    expect(results).toEqual([]);
  });
});
