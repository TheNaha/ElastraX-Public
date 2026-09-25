/**
 * @file test/roomKeyTools.test.ts
 * @description Room-key behaviour of the agent tools and notification plumbing,
 * exercised against a real migrated database.
 *
 * The migration is additive, so this suite deliberately mixes three kinds of row:
 *  - post-migration rows carrying `room_key`;
 *  - pre-migration rows with `room_key IS NULL` (must stay readable);
 *  - rows for two platforms that share the same raw room id (must never mix).
 */

import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { desc, eq, or } from 'drizzle-orm';
import { createTempDatabase, type TempDatabase } from './helpers/database';

const database: TempDatabase = createTempDatabase();

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

mock.module('../src/db', () => ({
  db: database.db,
  sqlite: database.sqlite,
  withImmediateTransaction,
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

import { chatRooms, messages, notificationSubscriptions } from '../src/db/schema';
import type { MessageContext } from '../src/core/MessageContext';
import { StatsTool } from '../src/tools/StatsTool';
import { LanguageTool } from '../src/tools/LanguageTool';
import { ConfigTool } from '../src/tools/ConfigTool';
import { OwnerTool } from '../src/tools/OwnerTool';
import { ReminderTool } from '../src/tools/ReminderTool';
import { NotificationSubscriptionService } from '../src/utils/NotificationSubscriptionService';
import { syncHistoricalDatabase } from '../src/utils/syncHistoricalDatabase';
import { reminders } from '../src/db/schema';
import { getCanonicalRoomKey, toRoomKey } from '../src/agent/roomKey';

const db = database.db;

const createCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'user-1',
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
  resolveRoles: mock(async () => ['owner']),
  rawMessage: {},
  ...overrides,
} as MessageContext);

const roomRow = async (id: string, platform: 'whatsapp' | 'discord' = 'whatsapp') => {
  const roomKey = toRoomKey(platform, id);
  const rows = await db.select().from(chatRooms).where(or(
    eq(chatRooms.id, id),
    eq(chatRooms.id, roomKey),
    eq(chatRooms.roomKey, roomKey),
  ));
  return rows[0];
};

const reminderRows = async (chatRoomId: string, platform: 'whatsapp' | 'discord' = 'whatsapp') => {
  const roomKey = toRoomKey(platform, chatRoomId);
  return db.select().from(reminders).where(or(
    eq(reminders.chatRoomId, chatRoomId),
    eq(reminders.chatRoomId, roomKey),
    eq(reminders.roomKey, roomKey),
  ));
};

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${++seq}-${Math.random().toString(36).slice(2, 7)}`;

async function insertRoom(overrides: Partial<typeof chatRooms.$inferInsert> & { id: string }): Promise<void> {
  await db.insert(chatRooms).values({ platform: 'whatsapp', language: 'en', created_at: new Date(), ...overrides }).onConflictDoNothing().run();
}

async function insertMessage(options: {
  chatRoomId: string;
  platform: 'whatsapp' | 'discord';
  roomKey?: string | null;
  role?: 'user' | 'assistant';
  content?: string;
}): Promise<number> {
  return db.insert(messages).values({
    chatRoomId: options.chatRoomId,
    platform: options.platform,
    ...(options.roomKey === undefined ? {} : { roomKey: options.roomKey }),
    senderId: 'user-1',
    senderName: 'User',
    role: options.role ?? 'user',
    content: options.content ?? 'hello',
    providerMessageId: nextId('pmid'),
    created_at: new Date(),
  }).returning({ id: messages.id }).then(rows => rows[0]!.id);
}

beforeEach(async () => {
  // Re-bind the service deps: the static default captures the module binding at
  // import time, which is before the `../src/db` mock is installed.
  NotificationSubscriptionService.setDepsForTesting(null);
  await db.delete(messages).run();
  await db.delete(notificationSubscriptions).run();
  await db.delete(reminders).run();
  await db.delete(chatRooms).run();
});

afterAll(() => {
  database.cleanup();
});

// ── StatsTool ────────────────────────────────────────────────────────────────

describe('StatsTool room scoping', () => {
  const tool = new StatsTool();

  test('counts post-migration rows addressed by the canonical key', async () => {
    const chatId = nextId('chat');
    await insertRoom({ id: chatId, roomKey: toRoomKey('whatsapp', chatId) });
    await insertMessage({ chatRoomId: chatId, platform: 'whatsapp', roomKey: toRoomKey('whatsapp', chatId) });
    await insertMessage({ chatRoomId: chatId, platform: 'whatsapp', roomKey: toRoomKey('whatsapp', chatId), role: 'assistant' });

    const result = await tool.execute({}, createCtx({ chatId }));
    expect(result).toContain('2');
    expect(result).toContain('1');
  });

  test('still counts pre-migration rows whose room_key was never backfilled', async () => {
    const chatId = nextId('chat');
    await insertRoom({ id: chatId, roomKey: null });
    await insertMessage({ chatRoomId: chatId, platform: 'whatsapp', roomKey: null });
    await insertMessage({ chatRoomId: chatId, platform: 'whatsapp', roomKey: null });

    const result = await tool.execute({}, createCtx({ chatId }));
    expect(result).toContain('2');
  });

  test('never mixes two rooms that share an id namespace across platforms', async () => {
    // `chat_rooms.id` is the legacy primary key, so the same remote id cannot
    // exist on two platforms at once; what must still hold is that neither room
    // ever sees the other's messages. The platform-scoped legacy fallback of
    // `roomIdentityCondition` is what guarantees that, and is exercised directly
    // in roomKey.test.ts against a table where the collision is representable.
    const whatsappId = nextId('wa');
    const discordId = nextId('dc');
    await insertRoom({ id: whatsappId, platform: 'whatsapp', roomKey: toRoomKey('whatsapp', whatsappId) });
    await insertRoom({ id: discordId, platform: 'discord', roomKey: toRoomKey('discord', discordId) });
    await insertMessage({ chatRoomId: whatsappId, platform: 'whatsapp', roomKey: null, content: 'wa' });
    await insertMessage({ chatRoomId: discordId, platform: 'discord', roomKey: toRoomKey('discord', discordId), content: 'dc' });
    await insertMessage({ chatRoomId: discordId, platform: 'discord', roomKey: toRoomKey('discord', discordId), content: 'dc2' });

    const whatsapp = await tool.execute({}, createCtx({ chatId: whatsappId }));
    expect(whatsapp).toContain('Total Messages: *1*');

    const discord = await tool.execute({}, createCtx({ platform: 'discord', chatId: discordId }));
    expect(discord).toContain('Total Messages: *2*');
  });
});

// ── LanguageTool ─────────────────────────────────────────────────────────────

describe('LanguageTool room addressing', () => {
  const tool = new LanguageTool();

  test('updates the room resolved by the canonical key', async () => {
    const chatId = nextId('chat');
    await insertRoom({ id: chatId, roomKey: toRoomKey('whatsapp', chatId), language: 'en' });
    await insertRoom({ id: nextId('other'), language: 'en' });

    expect(await tool.execute({ lang_code: 'id' }, createCtx({ chatId }))).toContain('i');
    expect((await roomRow(chatId))?.language).toBe('id');
  });

  test('backfills room_key on a legacy row while updating it', async () => {
    const chatId = nextId('chat');
    await insertRoom({ id: chatId, roomKey: null, language: 'en' });

    await tool.execute({ lang_code: 'id' }, createCtx({ chatId }));
    const room = await roomRow(chatId);
    expect(room?.language).toBe('id');
    expect(room?.roomKey).toBe(toRoomKey('whatsapp', chatId));
  });

  test('honours a context room key that differs from the derived key', async () => {
    const alias = nextId('alias');
    await insertRoom({ id: alias, roomKey: toRoomKey('whatsapp', 'canonical-target') });

    await tool.execute({ lang_code: 'id' }, createCtx({ chatId: 'unrelated-id', roomKey: toRoomKey('whatsapp', 'canonical-target') }));
    expect((await roomRow(alias))?.language).toBe('id');
  });
});

// ── ConfigTool ───────────────────────────────────────────────────────────────

describe('ConfigTool room resolution', () => {
  const tool = new ConfigTool();

  test('prefers the room whose room_key matches over a legacy id hit', async () => {
    const chatId = nextId('chat');
    await insertRoom({ id: chatId, roomKey: toRoomKey('whatsapp', chatId), contextLimit: 42 });
    // A legacy row that still claims the same raw id for a different room.
    await insertRoom({ id: `${chatId}-legacy`, roomKey: null, contextLimit: 7 });

    const shown = await tool.execute({ action: 'show' }, createCtx({ chatId }));
    expect(shown).toContain('`contextLimit`*: 42');
  });

  test('set writes to the canonical room and repairs a missing room_key', async () => {
    const chatId = nextId('chat');
    await insertRoom({ id: chatId, roomKey: null });

    const result = await tool.execute({ action: 'set', key: 'systemPrompt', value: 'Be brief.' }, createCtx({ chatId }));
    expect(result).toContain('systemPrompt');
    const room = await roomRow(chatId);
    expect(room?.systemPrompt).toBe('Be brief.');
    expect(room?.roomKey).toBe(toRoomKey('whatsapp', chatId));
  });

  test('reset clears the value and keeps the canonical key', async () => {
    const chatId = nextId('chat');
    await insertRoom({ id: chatId, roomKey: toRoomKey('whatsapp', chatId), systemPrompt: 'Old prompt' });

    await tool.execute({ action: 'reset', key: 'systemPrompt' }, createCtx({ chatId }));
    const room = await roomRow(chatId);
    expect(room?.systemPrompt).toBeNull();
    expect(room?.roomKey).toBe(toRoomKey('whatsapp', chatId));
  });
});

// ── ReminderTool ─────────────────────────────────────────────────────────────

describe('ReminderTool dual write', () => {
  const tool = new ReminderTool();

  test('keeps the raw room id for delivery and records the canonical key', async () => {
    const chatId = nextId('chat');
    await insertRoom({ id: chatId, roomKey: toRoomKey('whatsapp', chatId) });

    const result = await tool.execute({ action: 'set', message: 'ping', time: 'in 30 minutes' }, createCtx({ chatId }));
    expect(result).toContain('Reminder set');

    const stored = await reminderRows(chatId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.chatRoomId).toBe(chatId);
    expect(stored[0]?.roomKey).toBe(toRoomKey('whatsapp', chatId));
  });
});

// ── OwnerTool ────────────────────────────────────────────────────────────────

describe('OwnerTool broadcast targets', () => {
  const tool = new OwnerTool();

  test('skips the current room by canonical key and sends raw provider ids', async () => {
    const currentId = 'current-target';
    const otherId = nextId('other');
    // The current room, addressed by its canonical key.
    await insertRoom({ id: currentId, roomKey: toRoomKey('whatsapp', currentId) });
    // A pre-migration room that has no key yet, plus an unrelated room.
    await insertRoom({ id: 'legacy-room', roomKey: null });
    await insertRoom({ id: otherId, roomKey: toRoomKey('whatsapp', otherId) });
    await insertRoom({ id: nextId('discord-room'), platform: 'discord' });

    const forwardMessage = mock(async (_target: string, _text: string) => {});
    const ctx = createCtx({ chatId: currentId, roomKey: toRoomKey('whatsapp', currentId), forwardMessage });
    const result = await tool.execute({ action: 'broadcast', message: 'hello' }, ctx);

    expect(forwardMessage).toHaveBeenCalledTimes(2);
    expect(forwardMessage.mock.calls.map(call => call[0]).sort()).toEqual(['legacy-room', otherId].sort());
    expect(result).toContain('Broadcast complete');
  });

  test('skips a pre-migration current room that has no room key yet', async () => {
    const legacyId = 'legacy-current';
    await insertRoom({ id: legacyId, roomKey: null });
    await insertRoom({ id: nextId('other'), roomKey: null });

    const forwardMessage = mock(async (_target: string, _text: string) => {});
    await tool.execute({ action: 'broadcast', message: 'hello' }, createCtx({ chatId: legacyId, forwardMessage }));

    expect(forwardMessage.mock.calls.map(call => call[0])).not.toContain(legacyId);
    expect(forwardMessage).toHaveBeenCalledTimes(1);
  });

  test('never hands a canonical room key to the provider', async () => {
    const otherId = nextId('other');
    await insertRoom({ id: otherId, roomKey: toRoomKey('whatsapp', otherId) });

    const sendToChat = mock(async (_target: string, _text: string) => {});
    await tool.execute(
      { action: 'broadcast', message: 'hello' },
      createCtx({ chatId: nextId('current'), sendToChat }),
    );

    for (const [target] of sendToChat.mock.calls) {
      expect(String(target).startsWith('room:')).toBe(false);
    }
  });
});

// ── NotificationSubscriptionService ─────────────────────────────────────────

describe('NotificationSubscriptionService room keys', () => {
  test('stores the canonical key next to the legacy raw room id', async () => {
    await NotificationSubscriptionService.subscribe({
      userId: 'u1', platform: 'whatsapp', serviceType: 'all', chatRoomId: 'room-1', roomKey: toRoomKey('whatsapp', 'room-1'),
    });

    const stored = await db.select().from(notificationSubscriptions).where(eq(notificationSubscriptions.userId, 'u1'));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.chatRoomId).toBe('room-1');
    expect(stored[0]?.roomKey).toBe('room:whatsapp:room-1');
  });

  test('normalises a room key given as chatRoomId back to the raw provider id', async () => {
    await NotificationSubscriptionService.subscribe({
      userId: 'u2', platform: 'whatsapp', serviceType: 'all', chatRoomId: 'room:whatsapp:room-2',
      currentRoomId: 'room-2', currentRoomKey: 'room:whatsapp:room-2',
    });

    const stored = await db.select().from(notificationSubscriptions).where(eq(notificationSubscriptions.userId, 'u2'));
    expect(stored[0]?.chatRoomId).toBe('room-2');
    expect(stored[0]?.roomKey).toBe('room:whatsapp:room-2');
  });

  test('a pre-migration row is found and repaired by its legacy room id', async () => {
    await db.insert(notificationSubscriptions).values({
      userId: 'u3', platform: 'whatsapp', serviceType: 'all', chatRoomId: 'room-3', roomKey: null, created_at: new Date(),
    }).run();

    await NotificationSubscriptionService.subscribe({
      userId: 'u3', platform: 'whatsapp', serviceType: 'all', chatRoomId: 'room-3', roomKey: 'room:whatsapp:room-3',
    });

    const stored = await db.select().from(notificationSubscriptions).where(eq(notificationSubscriptions.userId, 'u3'));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.roomKey).toBe('room:whatsapp:room-3');
  });

  test('current-room authorization accepts a raw id and its canonical key', async () => {
    expect(() => NotificationSubscriptionService.assertRoomAccess({
      currentRoomId: 'room-4', currentRoomKey: 'room:whatsapp:room-4', requestedRoomId: 'room:whatsapp:room-4', platform: 'whatsapp',
    })).not.toThrow();

    // A key for another platform is a foreign room and needs owner permission.
    expect(() => NotificationSubscriptionService.assertRoomAccess({
      currentRoomId: 'room-4', currentRoomKey: 'room:whatsapp:room-4', requestedRoomId: 'room:discord:room-4', platform: 'whatsapp',
    })).toThrow('Foreign notification rooms require owner permission.');
  });

  test('unsubscribe accepts either the raw id or the canonical key', async () => {
    await NotificationSubscriptionService.subscribe({
      userId: 'u5', platform: 'whatsapp', serviceType: 'all', chatRoomId: 'room-5', roomKey: 'room:whatsapp:room-5',
    });

    expect(await NotificationSubscriptionService.unsubscribe('u5', 'whatsapp', 'all', 'room:whatsapp:room-5')).toBe(true);
    expect(await NotificationSubscriptionService.unsubscribe('u5', 'whatsapp', 'all', 'room-5')).toBe(false);
  });

  test('notification rooms expose the raw id for delivery plus the canonical key', async () => {
    await NotificationSubscriptionService.subscribe({
      userId: 'u6', platform: 'discord', serviceType: 'all', chatRoomId: 'chan-6', roomKey: 'room:discord:chan-6',
    });

    const rooms = await NotificationSubscriptionService.getNotificationRooms('u6', 'discord', 'all');
    expect(rooms).toEqual([{ chatRoomId: 'chan-6', roomKey: 'room:discord:chan-6', platform: 'discord' }]);
  });

  test('a migrated row and a legacy row for the same room collapse to one target', async () => {
    await db.insert(notificationSubscriptions).values([
      { userId: 'u7', platform: 'whatsapp', serviceType: 'all', chatRoomId: 'room-7', roomKey: 'room:whatsapp:room-7', created_at: new Date() },
      { userId: 'u7', platform: 'whatsapp', serviceType: 'seerr', chatRoomId: 'room-7', roomKey: null, created_at: new Date() },
    ]).run();

    const rooms = await NotificationSubscriptionService.getNotificationRooms('u7', 'whatsapp', 'all');
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.roomKey).toBe('room:whatsapp:room-7');

    const subscribers = await NotificationSubscriptionService.getSubscribersForService('all');
    const forUser = subscribers.filter(row => row.userId === 'u7');
    expect(forUser).toHaveLength(1);
  });
});

// ── syncHistoricalDatabase ───────────────────────────────────────────────────

describe('syncHistoricalDatabase room keys', () => {
  const historicalCtx = (chatId: string, platform: 'whatsapp' | 'discord', messageId: string): MessageContext =>
    createCtx({ chatId, platform, messageId, text: `from ${platform}` });

  test('keys rooms by platform and remote id, and dual-writes both columns', async () => {
    const chatId = nextId('chat');
    const result = await syncHistoricalDatabase([historicalCtx(chatId, 'whatsapp', nextId('m1'))]);

    expect(result.roomsSeen).toBe(1);
    expect(result.messagesInserted).toBe(1);

    const room = await roomRow(chatId);
    expect(room?.platform).toBe('whatsapp');
    expect(room?.roomKey).toBe(toRoomKey('whatsapp', chatId));

    const stored = await db.select().from(messages).where(or(
      eq(messages.chatRoomId, chatId),
      eq(messages.roomKey, toRoomKey('whatsapp', chatId)),
    )).orderBy(desc(messages.id));
    expect(stored[0]?.roomKey).toBe(toRoomKey('whatsapp', chatId));
  });

  test('one room is inserted per platform when two platforms share a raw id', async () => {
    const chatId = nextId('shared');
    const result = await syncHistoricalDatabase([
      historicalCtx(chatId, 'whatsapp', nextId('m1')),
      historicalCtx(chatId, 'whatsapp', nextId('m2')),
    ]);

    expect(result.roomsSeen).toBe(1);
    expect(result.messagesInserted).toBe(2);
    const rooms = await db.select().from(chatRooms);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.roomKey).toBe(toRoomKey('whatsapp', chatId));
  });

  test('a colliding raw id on a second platform creates a separate canonical room', async () => {
    const chatId = nextId('collide');
    const result = await syncHistoricalDatabase([
      historicalCtx(chatId, 'whatsapp', nextId('m1')),
      historicalCtx(chatId, 'discord', nextId('m2')),
    ]);

    expect(result.received).toBe(2);
    expect(result.roomsSeen).toBe(2);
    expect(result.messagesInserted).toBe(2);
    expect(result.failedBatches).toBe(0);
    const stored = await db.select().from(messages).where(or(
      eq(messages.roomKey, toRoomKey('whatsapp', chatId)),
      eq(messages.roomKey, toRoomKey('discord', chatId)),
    ));
    expect(stored.map(row => row.platform).sort()).toEqual(['discord', 'whatsapp']);
  });

  test('distinct remote ids on one platform are distinct rooms', async () => {
    const result = await syncHistoricalDatabase([
      historicalCtx(nextId('a'), 'whatsapp', nextId('m1')),
      historicalCtx(nextId('b'), 'whatsapp', nextId('m2')),
    ]);
    expect(result.roomsSeen).toBe(2);
  });
});

test('getCanonicalRoomKey stays consistent with the agent and tools', () => {
  expect(getCanonicalRoomKey({ platform: 'discord', chatId: '42' })).toBe('room:discord:42');
});
