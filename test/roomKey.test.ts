/**
 * @file test/roomKey.test.ts
 * @description Contract tests for the canonical room identity helper.
 *
 * Two things are pinned here:
 *  1. the canonical key format is byte identical to `toRoomKey()` from the
 *     database lane (`src/db/rooms`) and to migration 0022;
 *  2. the room condition the agent/tools issue reads BOTH the canonical
 *     `room_key` column and the pre-migration `chat_room_id` column, and stays
 *     collision free when two platforms share a raw room id.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { toRoomKey as registryToRoomKey, parseRoomKey as registryParseRoomKey } from '../src/db/rooms';
import {
  chatRoomsRoomColumns,
  getCanonicalRoomKey,
  isRoomKeyFor,
  isSameRoom,
  messagesRoomColumns,
  normalizeRoomId,
  parseRoomKey,
  pickPreferredRoomRow,
  remindersRoomKeyColumn,
  resolveRoomIdentity,
  roomIdFromRoomKey,
  roomIdentityCondition,
  roomKeyBackfill,
  roomRemoteId,
  setRoomKeyColumnsForTesting,
  subscriptionRoomColumns,
  toRoomKey,
  type RoomColumns,
  type RoomIdentity,
} from '../src/agent/roomKey';
import { chatRooms, messages, notificationSubscriptions, reminders } from '../src/db/schema';

// ── Canonical form ────────────────────────────────────────────────────────────

describe('canonical room key format', () => {
  test('matches the room registry implementation owned by the database lane', () => {
    for (const [platform, chatId] of [
      ['whatsapp', '628123@s.whatsapp.net'],
      ['discord', '1234567890'],
      ['whatsapp', '120363000000000000@g.us'],
    ] as const) {
      expect(toRoomKey(platform, chatId)).toBe(registryToRoomKey(platform, chatId));
    }
  });

  test('is platform scoped, so the same raw id yields two different rooms', () => {
    expect(toRoomKey('whatsapp', 'shared')).toBe('room:whatsapp:shared');
    expect(toRoomKey('discord', 'shared')).toBe('room:discord:shared');
    expect(toRoomKey('whatsapp', 'shared')).not.toBe(toRoomKey('discord', 'shared'));
  });

  test('parses a key back into its platform and remote id', () => {
    expect(parseRoomKey('room:whatsapp:123@g.us')).toEqual({ platform: 'whatsapp', remoteRoomId: '123@g.us' });
    // A raw provider chat id is not a key: it has no platform segment.
    expect(parseRoomKey('1234567890')).toBeNull();
    expect(parseRoomKey('628123@s.whatsapp.net')).toBeNull();
  });

  test('strips only its own platform prefix and tolerates the pre-migration form', () => {
    expect(roomIdFromRoomKey('room:whatsapp:abc', 'whatsapp')).toBe('abc');
    expect(roomIdFromRoomKey('whatsapp:abc', 'whatsapp')).toBe('abc');
    // A key for another platform must never be treated as a local room.
    expect(roomIdFromRoomKey('room:discord:abc', 'whatsapp')).toBeNull();
    expect(roomIdFromRoomKey('abc', 'whatsapp')).toBeNull();
    expect(roomIdFromRoomKey(null, 'whatsapp')).toBeNull();
  });

  test('agrees with the registry parser on well formed keys', () => {
    const key = registryToRoomKey('whatsapp', '628123@s.whatsapp.net');
    expect(parseRoomKey(key)).toEqual(registryParseRoomKey(key));
  });

  test('normalises a room reference given as either a key or a raw id', () => {
    expect(normalizeRoomId('whatsapp', 'room:whatsapp:abc')).toBe('abc');
    expect(normalizeRoomId('whatsapp', 'abc')).toBe('abc');
    // A foreign key is left intact so authorization can reject it.
    expect(normalizeRoomId('whatsapp', 'room:discord:abc')).toBe('room:discord:abc');
  });

  test('compares rooms across both reference forms', () => {
    expect(isSameRoom('whatsapp', 'room:whatsapp:abc', 'abc')).toBe(true);
    expect(isSameRoom('whatsapp', 'room:whatsapp:abc', 'room:whatsapp:abc')).toBe(true);
    expect(isSameRoom('whatsapp', 'abc', 'xyz')).toBe(false);
    expect(isSameRoom('whatsapp', 'room:discord:abc', 'abc')).toBe(false);
    expect(isSameRoom('whatsapp', null, 'abc')).toBe(false);
    expect(isRoomKeyFor('room:discord:abc', 'whatsapp')).toBe(false);
  });
});

// ── Context helpers ───────────────────────────────────────────────────────────

describe('getCanonicalRoomKey', () => {
  const base = { platform: 'whatsapp', chatId: '123@g.us' } as const;

  test('derives the key from platform and chat id when the context has none', () => {
    expect(getCanonicalRoomKey(base)).toBe('room:whatsapp:123@g.us');
  });

  test('prefers the key the runtime already resolved', () => {
    expect(getCanonicalRoomKey({ ...base, roomKey: 'room:whatsapp:alias' })).toBe('room:whatsapp:alias');
  });

  test('ignores a blank context key', () => {
    expect(getCanonicalRoomKey({ ...base, roomKey: '   ' })).toBe('room:whatsapp:123@g.us');
  });

  test('resolveRoomIdentity keeps the raw provider id for provider I/O', () => {
    expect(resolveRoomIdentity({ ...base, roomKey: 'room:whatsapp:alias' })).toEqual({
      platform: 'whatsapp',
      roomKey: 'room:whatsapp:alias',
      roomId: '123@g.us',
    });
  });

  test('roomRemoteId always yields a raw provider id, never a key', () => {
    expect(roomRemoteId({ id: '123@g.us', roomKey: 'room:whatsapp:123@g.us' }, 'whatsapp')).toBe('123@g.us');
    expect(roomRemoteId({ id: '123@g.us', roomKey: null }, 'whatsapp')).toBe('123@g.us');
    // Row stored under the canonical key only (no legacy id).
    expect(roomRemoteId({ id: 'room:whatsapp:123@g.us', roomKey: 'room:whatsapp:123@g.us' }, 'whatsapp')).toBe('123@g.us');
    // A key for a foreign platform is never handed to a provider.
    expect(roomRemoteId({ id: '123@g.us', roomKey: 'room:discord:123@g.us' }, 'whatsapp')).toBe('123@g.us');
    expect(roomRemoteId(null, 'whatsapp')).toBe('');
  });

  test('pickPreferredRoomRow prefers the canonical match', () => {
    const legacy = { id: 'a', roomKey: null };
    const canonical = { id: 'b', roomKey: 'room:whatsapp:a' };
    expect(pickPreferredRoomRow([legacy, canonical], 'room:whatsapp:a')).toBe(canonical);
    expect(pickPreferredRoomRow([legacy], 'room:whatsapp:a')).toBe(legacy);
    expect(pickPreferredRoomRow([], 'room:whatsapp:a')).toBeUndefined();
  });
});

// ── Dual read / dual write ────────────────────────────────────────────────────

const messageProbe = sqliteTable('message_probe', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  chatRoomId: text('chat_room_id'),
  platform: text('platform'),
  roomKey: text('room_key'),
});

describe('roomIdentityCondition', () => {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite);
  const roomColumns: RoomColumns = { legacy: messageProbe.chatRoomId, canonical: messageProbe.roomKey, platform: messageProbe.platform };
  const legacyOnlyColumns: RoomColumns = { legacy: messageProbe.chatRoomId, canonical: null, platform: messageProbe.platform };
  const identity: RoomIdentity = { platform: 'whatsapp', roomKey: 'room:whatsapp:shared', roomId: 'shared' };

  beforeEach(() => {
    sqlite.exec('CREATE TABLE IF NOT EXISTS message_probe (seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_room_id TEXT, platform TEXT, room_key TEXT)');
    sqlite.exec('DELETE FROM message_probe');
  });

  const rows = async (columns: RoomColumns) =>
    db.select().from(messageProbe).where(roomIdentityCondition(columns, identity)).all();

  test('reads the canonical room_key column when the schema exposes it', async () => {
    sqlite.exec("INSERT INTO message_probe (chat_room_id, platform, room_key) VALUES ('shared', 'whatsapp', 'room:whatsapp:shared')");
    expect(await rows(roomColumns)).toHaveLength(1);
  });

  test('falls back to the legacy chat_room_id column for pre-migration rows', async () => {
    sqlite.exec("INSERT INTO message_probe (chat_room_id, platform, room_key) VALUES ('shared', 'whatsapp', NULL)");
    expect(await rows(roomColumns)).toHaveLength(1);
    expect(await rows(legacyOnlyColumns)).toHaveLength(1);
  });

  test('keeps two platforms that share a raw room id apart', async () => {
    sqlite.exec("INSERT INTO message_probe (chat_room_id, platform, room_key) VALUES ('shared', 'whatsapp', 'room:whatsapp:shared')");
    sqlite.exec("INSERT INTO message_probe (chat_room_id, platform, room_key) VALUES ('shared', 'discord', 'room:discord:shared')");
    const found = await rows(roomColumns);
    expect(found).toHaveLength(1);
    expect(found[0]?.platform).toBe('whatsapp');
  });

  test('still reads pre-migration rows whose platform column is null', async () => {
    sqlite.exec("INSERT INTO message_probe (chat_room_id, platform, room_key) VALUES ('shared', NULL, NULL)");
    expect(await rows(roomColumns)).toHaveLength(1);
  });

  test('a foreign key never matches a local room', async () => {
    sqlite.exec("INSERT INTO message_probe (chat_room_id, platform, room_key) VALUES ('shared', 'discord', 'room:discord:shared')");
    expect(await rows(roomColumns)).toHaveLength(0);
  });

  test('the canonical column alone is enough to find a row', async () => {
    sqlite.exec("INSERT INTO message_probe (chat_room_id, platform, room_key) VALUES ('legacy-id', 'whatsapp', 'room:whatsapp:shared')");
    const canonicalOnly: RoomColumns = { legacy: messageProbe.chatRoomId, canonical: messageProbe.roomKey, platform: null };
    expect(await rows(canonicalOnly)).toHaveLength(1);
  });

  test('emits the canonical column in the generated SQL', () => {
    const compiled = db.select().from(messageProbe).where(roomIdentityCondition(roomColumns, identity)).toSQL();
    expect(compiled.sql).toContain('"room_key"');
    expect(compiled.params).toContain('room:whatsapp:shared');
    expect(compiled.params).toContain('shared');
  });
});

describe('dual write helpers', () => {
  test('write the canonical key only when the schema exposes the column', () => {
    setRoomKeyColumnsForTesting({ messages: messageProbe.roomKey });
    expect(roomKeyBackfill(messageProbe.roomKey, null, 'room:whatsapp:a')).toEqual({ roomKey: 'room:whatsapp:a' });
    setRoomKeyColumnsForTesting({ messages: null });
    expect(roomKeyBackfill(null, null, 'room:whatsapp:a')).toEqual({});
    setRoomKeyColumnsForTesting(null);
  });

  test('never rewrite a row that already carries the canonical key', () => {
    expect(roomKeyBackfill(messageProbe.roomKey, 'room:whatsapp:a', 'room:whatsapp:a')).toEqual({});
    expect(roomKeyBackfill(messageProbe.roomKey, '  ', 'room:whatsapp:a')).toEqual({ roomKey: 'room:whatsapp:a' });
  });
});

describe('column detection against the live schema', () => {
  test('resolves a room_key column for every table the agent and tools touch', () => {
    expect(chatRoomsRoomColumns().canonical).toBe(chatRooms.roomKey);
    expect(messagesRoomColumns().canonical).toBe(messages.roomKey);
    expect(subscriptionRoomColumns().canonical).toBe(notificationSubscriptions.roomKey);
    expect(remindersRoomKeyColumn()).toBe(reminders.roomKey);
  });

  test('degrades to legacy-only conditions when the column is absent', () => {
    setRoomKeyColumnsForTesting({ chatRooms: null, messages: null });
    expect(chatRoomsRoomColumns().canonical).toBeNull();
    expect(messagesRoomColumns().canonical).toBeNull();
    // The legacy id stays queryable, so a pre-migration database still works.
    const compiled = drizzle(new Database(':memory:'))
      .select({ id: messages.id })
      .from(messages)
      .where(roomIdentityCondition(messagesRoomColumns(), { platform: 'whatsapp', roomKey: 'room:whatsapp:a', roomId: 'a' }))
      .toSQL();
    const whereClause = compiled.sql.slice(compiled.sql.indexOf(' where '));
    expect(whereClause).not.toContain('room_key');
    expect(whereClause).toContain('chat_room_id');
    expect(compiled.params).toContain('a');
    // The canonical key is still accepted as a room reference value.
    expect(compiled.params).toContain('room:whatsapp:a');
    setRoomKeyColumnsForTesting(null);
  });

  test('detects a room_key column on an injected table', () => {
    expect(subscriptionRoomColumns(messageProbe).canonical).toBe(messageProbe.roomKey);
  });

  test('treats a plain test double as a legacy-only table', () => {
    const fakeTable = { id: 'id', userId: 'user_id', platform: 'platform', serviceType: 'service_type', chatRoomId: 'chat_room_id' };
    expect(subscriptionRoomColumns(fakeTable).canonical).toBeNull();
  });
});

afterAll(() => {
  setRoomKeyColumnsForTesting(null);
});
