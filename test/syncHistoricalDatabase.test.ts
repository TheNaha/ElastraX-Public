import { describe, test, expect, mock, afterAll, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { MessageContext } from '../src/core/MessageContext';
import { createTempDatabase, type TempDatabase } from './helpers/database';
import { chatRooms, messages } from '../src/db/schema';

// A real, migrated temp database keeps this mock a strict superset of the
// module's public surface, so a leaked mock can never break another test file.
const database: TempDatabase = createTempDatabase();
let roomFailuresRemaining = 0;
let messageFailuresRemaining = 0;
let roomAttempts = 0;
let messageAttempts = 0;

// Mirrors src/db/runtime.ts exactly: the return value must be propagated,
// because callers such as claimInboxEvents rely on it.
function withImmediateTransaction<T>(sqlite: TempDatabase['sqlite'], operation: () => T): T {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      sqlite.exec('ROLLBACK');
    } catch {
      // The transaction may already be rolled back; surface the original error.
    }
    throw error;
  }
}

afterAll(() => {
  database.cleanup();
});

mock.module('../src/db', () => ({
  sqlite: database.sqlite,
  withImmediateTransaction,
  db: {
    select: (...args: unknown[]) => (database.db.select as (...a: unknown[]) => unknown)(...args),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        const builder = (database.db.insert as (t: unknown) => any)(table).values(values as any);
        const guard = () => {
          const isRoom = table === chatRooms;
          if (isRoom) {
            roomAttempts++;
            if (roomFailuresRemaining > 0) {
              roomFailuresRemaining--;
              throw new Error('Simulated room DB error');
            }
          } else {
            messageAttempts++;
            if (messageFailuresRemaining > 0) {
              messageFailuresRemaining--;
              throw new Error('Simulated message DB error');
            }
          }
        };
        return {
          onConflictDoNothing: () => ({
            run: async () => {
              guard();
              return builder.onConflictDoNothing().run();
            },
            // drizzle exposes .returning() on the conflict builder; mirror it so
            // the source takes the same path it takes in production.
            returning: (selection: unknown) => ({
              all: async () => {
                guard();
                return builder.onConflictDoNothing().returning(selection as never).all();
              },
            }),
          }),
        };
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

import { syncHistoricalDatabase } from '../src/utils/syncHistoricalDatabase';

// ── Helpers ───────────────────────────────────────────────────────────────────
let runToken = 0;
const unique = (prefix: string): string => `${prefix}-${++runToken}-${Math.random().toString(36).slice(2, 8)}`;

const makeCtx = (overrides: Partial<MessageContext> & { messageId?: string } = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: unique('chat'),
  senderId: 'sender-1',
  senderName: 'Alice',
  text: 'Hello world',
  isGroup: false,
  hasMedia: false,
  rawMessage: {},
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  messageId: unique('msg'),
  mediaReady: Promise.resolve(),
  ...overrides,
} as MessageContext);

const roomRow = (id: string) => database.db.select().from(chatRooms).where(eq(chatRooms.id, id)).then(rows => rows[0]);
const messageRowsFor = (chatId: string) =>
  database.db.select().from(messages).where(eq(messages.chatRoomId, chatId));

describe('syncHistoricalDatabase', () => {
  beforeEach(() => {
    roomFailuresRemaining = 0;
    messageFailuresRemaining = 0;
    roomAttempts = 0;
    messageAttempts = 0;
  });

  test('should return immediately when given an empty array', async () => {
    const result = await syncHistoricalDatabase([]);
    expect(result).toEqual({ received: 0, roomsSeen: 0, messagesInserted: 0, failedBatches: 0 });
    expect(roomAttempts).toBe(0);
    expect(messageAttempts).toBe(0);
  });

  test('should insert one room and one message for a single context', async () => {
    const ctx = makeCtx();
    const result = await syncHistoricalDatabase([ctx]);

    expect(result.received).toBe(1);
    expect(result.roomsSeen).toBe(1);
    expect(result.failedBatches).toBe(0);
    expect(result.messagesInserted).toBe(1);
    const room = await roomRow(ctx.chatId);
    expect(room?.platform).toBe('whatsapp');
    expect(room?.language).toBe('en');

    const stored = await messageRowsFor(ctx.chatId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).toBe('Hello world');
    expect(stored[0]?.providerMessageId).toBe(ctx.messageId);
  });

  test('should only insert the room once for multiple messages from the same chat', async () => {
    const chatId = unique('chat');
    const result = await syncHistoricalDatabase([
      makeCtx({ chatId, messageId: unique('msg') }),
      makeCtx({ chatId, messageId: unique('msg') }),
      makeCtx({ chatId, messageId: unique('msg') }),
    ]);

    expect(result.roomsSeen).toBe(1);
    expect(await messageRowsFor(chatId)).toHaveLength(3);
  });

  test('should insert a separate room for each unique chatId', async () => {
    const roomA = unique('room');
    const roomB = unique('room');
    const result = await syncHistoricalDatabase([
      makeCtx({ chatId: roomA, messageId: unique('msg') }),
      makeCtx({ chatId: roomB, messageId: unique('msg') }),
    ]);

    expect(result.roomsSeen).toBe(2);
    expect((await roomRow(roomA))?.id).toBe(roomA);
    expect((await roomRow(roomB))?.id).toBe(roomB);
  });

  test('should assign role "user" when rawMessage.key.fromMe is false', async () => {
    const ctx = makeCtx({ rawMessage: { key: { fromMe: false } } });
    await syncHistoricalDatabase([ctx]);
    expect((await messageRowsFor(ctx.chatId))[0]?.role).toBe('user');
  });

  test('should assign role "user" when rawMessage.key.fromMe is absent', async () => {
    const ctx = makeCtx({ rawMessage: {} });
    await syncHistoricalDatabase([ctx]);
    expect((await messageRowsFor(ctx.chatId))[0]?.role).toBe('user');
  });

  test('should assign role "assistant" when rawMessage.key.fromMe is true', async () => {
    const ctx = makeCtx({ rawMessage: { key: { fromMe: true } } });
    await syncHistoricalDatabase([ctx]);
    expect((await messageRowsFor(ctx.chatId))[0]?.role).toBe('assistant');
  });

  test('should use rawMessage.messageTimestamp for created_at', async () => {
    const ts = 1_700_000_000;
    const ctx = makeCtx({ rawMessage: { messageTimestamp: ts } });
    await syncHistoricalDatabase([ctx]);
    expect((await messageRowsFor(ctx.chatId))[0]?.created_at.getTime()).toBe(ts * 1_000);
  });

  test('should fall back to current time when messageTimestamp is absent', async () => {
    const before = Date.now();
    const ctx = makeCtx({ rawMessage: {} });
    await syncHistoricalDatabase([ctx]);
    const created = (await messageRowsFor(ctx.chatId))[0]!.created_at.getTime();
    expect(created).toBeGreaterThanOrEqual(before - 1_000);
    expect(created).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  test('should clamp an implausible future timestamp to now', async () => {
    const farFuture = Math.floor(Date.now() / 1_000) + 86_400;
    const before = Date.now();
    const ctx = makeCtx({ rawMessage: { messageTimestamp: farFuture } });
    await syncHistoricalDatabase([ctx]);
    expect((await messageRowsFor(ctx.chatId))[0]!.created_at.getTime()).toBeLessThanOrEqual(before + 60_000);
  });

  test('should set mimeType to null when ctx.text is non-empty', async () => {
    const ctx = makeCtx({ text: 'some text' });
    await syncHistoricalDatabase([ctx]);
    expect((await messageRowsFor(ctx.chatId))[0]?.mimeType).toBeNull();
  });

  test('should set mimeType to "application/octet-stream" when ctx.text is empty', async () => {
    const ctx = makeCtx({ text: '' });
    await syncHistoricalDatabase([ctx]);
    expect((await messageRowsFor(ctx.chatId))[0]?.mimeType).toBe('application/octet-stream');
  });

  test('should store the senderId and senderName in the message insert', async () => {
    const ctx = makeCtx({ senderId: 'alice@s.whatsapp.net', senderName: 'Alice Wonderland' });
    await syncHistoricalDatabase([ctx]);
    const stored = (await messageRowsFor(ctx.chatId))[0];
    expect(stored?.senderId).toBe('alice@s.whatsapp.net');
    expect(stored?.senderName).toBe('Alice Wonderland');
  });

  test('should fall back to a bounded sender name when none is available', async () => {
    const ctx = makeCtx({ senderName: '' });
    await syncHistoricalDatabase([ctx]);
    expect((await messageRowsFor(ctx.chatId))[0]?.senderName).toBe('unknown');
  });

  test('should store the providerMessageId and platform on the message insert', async () => {
    const ctx = makeCtx({ messageId: 'provider-abc-123', platform: 'discord' });
    await syncHistoricalDatabase([ctx]);
    const stored = (await messageRowsFor(ctx.chatId))[0];
    expect(stored?.providerMessageId).toBe('provider-abc-123');
    expect(stored?.platform).toBe('discord');
    expect((await roomRow(ctx.chatId))?.platform).toBe('discord');
  });

  test('should store only the sanitised projection of rawMessage', async () => {
    const raw = {
      id: 'XYZ',
      key: { id: 'XYZ', fromMe: false, participant: 'secret@s.whatsapp.net' },
      message: { timestamp: 123 },
      mediaKey: 'super-secret-media-key',
      attachments: [{ url: 'https://example.com/a.jpg' }, { url: 'https://example.com/b.jpg' }],
    };
    const ctx = makeCtx({ rawMessage: raw });
    await syncHistoricalDatabase([ctx]);

    const stored = (await messageRowsFor(ctx.chatId))[0];
    expect(JSON.parse(stored!.rawMessage as string)).toEqual({
      id: 'XYZ',
      fromMe: false,
      timestamp: 123,
      attachmentCount: 2,
    });
    expect(stored?.rawMessage).not.toContain('super-secret-media-key');
    expect(stored?.rawMessage).not.toContain('secret@s.whatsapp.net');
  });

  test('should truncate oversized content and sender names', async () => {
    const ctx = makeCtx({ text: 'x'.repeat(25_000), senderName: 'y'.repeat(400) });
    await syncHistoricalDatabase([ctx]);
    const stored = (await messageRowsFor(ctx.chatId))[0];
    expect(stored!.content).toHaveLength(20_000);
    expect(stored!.senderName).toHaveLength(200);
  });

  test('should retry a transient room failure and succeed without dropping messages', async () => {
    roomFailuresRemaining = 1;
    const ctx = makeCtx();
    const result = await syncHistoricalDatabase([ctx]);

    expect(roomAttempts).toBe(2);
    expect(result.failedBatches).toBe(0);
    expect(await messageRowsFor(ctx.chatId)).toHaveLength(1);
  });

  test('should report a failed batch and skip messages for the affected room only', async () => {
    roomFailuresRemaining = 99;
    messageFailuresRemaining = 99;
    const roomA = unique('room');
    const roomB = unique('room');
    const result = await syncHistoricalDatabase([
      makeCtx({ chatId: roomA, messageId: unique('msg') }),
      makeCtx({ chatId: roomB, messageId: unique('msg') }),
    ]);

    expect(roomAttempts).toBe(3);
    expect(result.failedBatches).toBe(1);
    // The room batch failed, so its messages are never attempted.
    expect(messageAttempts).toBe(0);
    expect(await messageRowsFor(roomA)).toHaveLength(0);
    expect(await messageRowsFor(roomB)).toHaveLength(0);
  });

  test('should report a failed batch when only the message insert fails', async () => {
    messageFailuresRemaining = 99;
    const ctx = makeCtx();
    const result = await syncHistoricalDatabase([ctx]);

    expect(messageAttempts).toBe(3);
    expect(result.failedBatches).toBe(1);
    expect(result.messagesInserted).toBe(0);
    expect(await messageRowsFor(ctx.chatId)).toHaveLength(0);
  });

  test('should default room language to "en" for historical rooms', async () => {
    const ctx = makeCtx();
    await syncHistoricalDatabase([ctx]);
    expect((await roomRow(ctx.chatId))?.language).toBe('en');
  });

  test('reports zero inserts when a message already exists for the same provider id', async () => {
    const chatId = unique('chat');
    const messageId = unique('msg');
    const first = await syncHistoricalDatabase([makeCtx({ chatId, messageId })]);
    const second = await syncHistoricalDatabase([makeCtx({ chatId, messageId })]);

    expect(first.messagesInserted).toBe(1);
    expect(second.messagesInserted).toBe(0);
    expect(await messageRowsFor(chatId)).toHaveLength(1);
  });
});
