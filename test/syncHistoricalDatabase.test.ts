import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';

// ── Capture insert calls so we can inspect what was written to the DB ─────────
const insertedValues: any[] = [];
let shouldThrowOnNext = false;

mock.module('../src/db', () => ({
  db: {
    insert: () => ({
      values: (vals: any) => {
        if (shouldThrowOnNext) {
          shouldThrowOnNext = false;
          throw new Error('Simulated DB error');
        }
        // Since we are now inserting batches (arrays), we should spread them
        // into insertedValues to keep the rest of the tests compatible.
        if (Array.isArray(vals)) {
          insertedValues.push(...vals);
        } else {
          insertedValues.push(vals);
        }
        return { onConflictDoNothing: async () => {} };
      },
    }),
  },
}));

const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

// Import AFTER mocks are registered
import { syncHistoricalDatabase } from '../src/utils/syncHistoricalDatabase';

// ── Helpers ───────────────────────────────────────────────────────────────────
const makeCtx = (overrides: Partial<MessageContext> & { messageId?: string } = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'sender-1',
  senderName: 'Alice',
  text: 'Hello world',
  isGroup: false,
  hasMedia: false,
  rawMessage: {},
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  messageId: 'msg-001',
  mediaReady: Promise.resolve(),
  ...overrides,
} as MessageContext);

describe('syncHistoricalDatabase', () => {
  beforeEach(() => {
    insertedValues.length = 0;
    shouldThrowOnNext = false;
  });

  test('should return immediately when given an empty array', async () => {
    await syncHistoricalDatabase([]);
    expect(insertedValues.length).toBe(0);
  });

  test('should insert one room and one message for a single context', async () => {
    await syncHistoricalDatabase([makeCtx()]);
    // First insert = room, second = message
    expect(insertedValues.length).toBe(2);
    expect(insertedValues[0].id).toBe('chat-1');
    expect(insertedValues[0].platform).toBe('whatsapp');
    expect(insertedValues[1].chatRoomId).toBe('chat-1');
    expect(insertedValues[1].content).toBe('Hello world');
  });

  test('should only insert the room once for multiple messages from the same chat', async () => {
    const msgs = [
      makeCtx({ messageId: 'msg-1' }),
      makeCtx({ messageId: 'msg-2' }),
      makeCtx({ messageId: 'msg-3' }),
    ];
    await syncHistoricalDatabase(msgs);

    // Room inserted once, messages inserted 3 times = 4 total
    expect(insertedValues.length).toBe(4);
    const roomInserts = insertedValues.filter(v => v.id === 'chat-1');
    expect(roomInserts.length).toBe(1);
  });

  test('should insert a separate room for each unique chatId', async () => {
    const msgs = [
      makeCtx({ chatId: 'room-A', messageId: 'msg-1' }),
      makeCtx({ chatId: 'room-B', messageId: 'msg-2' }),
    ];
    await syncHistoricalDatabase(msgs);

    const roomInserts = insertedValues.filter(v => v.platform !== undefined && v.id !== undefined);
    expect(roomInserts.length).toBe(2);
    expect(roomInserts.map(r => r.id)).toContain('room-A');
    expect(roomInserts.map(r => r.id)).toContain('room-B');
  });

  test('should assign role "user" when rawMessage.key.fromMe is false', async () => {
    await syncHistoricalDatabase([
      makeCtx({ rawMessage: { key: { fromMe: false } } }),
    ]);
    const msgInsert = insertedValues.find(v => v.chatRoomId !== undefined);
    expect(msgInsert.role).toBe('user');
  });

  test('should assign role "user" when rawMessage.key.fromMe is absent', async () => {
    await syncHistoricalDatabase([makeCtx({ rawMessage: {} })]);
    const msgInsert = insertedValues.find(v => v.chatRoomId !== undefined);
    expect(msgInsert.role).toBe('user');
  });

  test('should assign role "assistant" when rawMessage.key.fromMe is true', async () => {
    await syncHistoricalDatabase([
      makeCtx({ rawMessage: { key: { fromMe: true } } }),
    ]);
    const msgInsert = insertedValues.find(v => v.chatRoomId !== undefined);
    expect(msgInsert.role).toBe('assistant');
  });

  test('should use rawMessage.messageTimestamp for created_at', async () => {
    const ts = 1700000000; // seconds since epoch
    await syncHistoricalDatabase([
      makeCtx({ rawMessage: { messageTimestamp: ts } }),
    ]);
    const msgInsert = insertedValues.find(v => v.chatRoomId !== undefined);
    expect(msgInsert.created_at.getTime()).toBe(ts * 1000);
  });

  test('should fall back to current time when messageTimestamp is absent', async () => {
    const before = Date.now();
    await syncHistoricalDatabase([makeCtx({ rawMessage: {} })]);
    const after = Date.now();
    const msgInsert = insertedValues.find(v => v.chatRoomId !== undefined);
    expect(msgInsert.created_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(msgInsert.created_at.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  test('should set mimeType to undefined when ctx.text is non-empty', async () => {
    await syncHistoricalDatabase([makeCtx({ text: 'some text' })]);
    const msgInsert = insertedValues.find(v => v.chatRoomId !== undefined);
    expect(msgInsert.mimeType).toBeUndefined();
  });

  test('should set mimeType to "application/octet-stream" when ctx.text is empty', async () => {
    await syncHistoricalDatabase([makeCtx({ text: '' })]);
    const msgInsert = insertedValues.find(v => v.chatRoomId !== undefined);
    expect(msgInsert.mimeType).toBe('application/octet-stream');
  });

  test('should store the senderId and senderName in the message insert', async () => {
    await syncHistoricalDatabase([
      makeCtx({ senderId: 'alice@s.whatsapp.net', senderName: 'Alice Wonderland' }),
    ]);
    const msgInsert = insertedValues.find(v => v.chatRoomId !== undefined);
    expect(msgInsert.senderId).toBe('alice@s.whatsapp.net');
    expect(msgInsert.senderName).toBe('Alice Wonderland');
  });

  test('should store the providerMessageId from ctx.messageId', async () => {
    await syncHistoricalDatabase([makeCtx({ messageId: 'provider-abc-123' })]);
    const msgInsert = insertedValues.find(v => v.chatRoomId !== undefined);
    expect(msgInsert.providerMessageId).toBe('provider-abc-123');
  });

  test('should store a JSON-serialised rawMessage', async () => {
    const raw = { key: { id: 'XYZ', fromMe: false }, text: 'hi' };
    await syncHistoricalDatabase([makeCtx({ rawMessage: raw })]);
    const msgInsert = insertedValues.find(v => v.chatRoomId !== undefined);
    expect(msgInsert.rawMessage).toBe(JSON.stringify(raw));
  });

  test('should continue processing remaining messages after a single failure', async () => {
    // The first values() call will throw (room insert for the single message).
    // syncHistoricalDatabase must catch the error and NOT propagate it.
    shouldThrowOnNext = true;

    const single = [makeCtx({ messageId: 'msg-single' })];
    await expect(syncHistoricalDatabase(single)).resolves.toBeUndefined();
    // In the new batch implementation, room inserts happen before message inserts.
    // So if room insert throws, it's caught, and message insert still proceeds!
    // That means we *should* see the message insert in insertedValues.
    expect(insertedValues.length).toBe(1);
    expect(insertedValues[0].providerMessageId).toBe('msg-single');
  });

  test('should default room language to "en" for historical rooms', async () => {
    await syncHistoricalDatabase([makeCtx()]);
    const roomInsert = insertedValues.find(v => v.id !== undefined && v.language !== undefined);
    expect(roomInsert?.language).toBe('en');
  });

  test('should work with Discord platform messages', async () => {
    await syncHistoricalDatabase([
      makeCtx({
        platform: 'discord',
        chatId: 'discord-channel-1',
        senderId: 'discord-user-1',
        messageId: 'discord-msg-1',
      }),
    ]);
    const roomInsert = insertedValues.find(v => v.id === 'discord-channel-1');
    expect(roomInsert?.platform).toBe('discord');
  });
});
