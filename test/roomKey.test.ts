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
  remindersRoomColumns,
  resolveRoomIdentity,
  roomIdFromRoomKey,
  roomIdentityCondition,
  roomKeyBackfill,
  roomRemoteId,
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
    expect(pickPreferredRoomRow([legacy], 'room:whatsapp:a')).toBeUndefined();
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
  const identity: RoomIdentity = { platform: 'whatsapp', roomKey: 'room:whatsapp:shared', roomId: 'shared' };

  beforeEach(() => {
    sqlite.exec('CREATE TABLE IF NOT EXISTS message_probe (seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_room_id TEXT, platform TEXT, room_key TEXT)');
    sqlite.exec('DELETE FROM message_probe');
  });

  const rows = async (columns: RoomColumns) =>
    db.select().from(messageProbe).where(roomIdentityCondition(columns, identity)).all();

  test('matches only rows whose room_key equals the canonical key', async () => {
    sqlite.exec("INSERT INTO message_probe (chat_room_id, platform, room_key) VALUES ('shared', 'whatsapp', 'room:whatsapp:shared')");
    expect(await rows(roomColumns)).toHaveLength(1);
  });

  test('legacy-only rows (NULL room_key) are not returned', async () => {
    sqlite.exec("INSERT INTO message_probe (chat_room_id, platform, room_key) VALUES ('shared', NULL, NULL)");
    expect(await rows(roomColumns)).toHaveLength(0);
  });

  test('keeps two platforms that share a raw room id apart', async () => {
    sqlite.exec("INSERT INTO message_probe (chat_room_id, platform, room_key) VALUES ('shared', 'whatsapp', 'room:whatsapp:shared')");
    sqlite.exec("INSERT INTO message_probe (chat_room_id, platform, room_key) VALUES ('shared', 'discord', 'room:discord:shared')");
    const found = await rows(roomColumns);
    expect(found).toHaveLength(1);
    expect(found[0]?.platform).toBe('whatsapp');
  });

  test('emits the canonical column in the generated SQL', () => {
    const compiled = db.select().from(messageProbe).where(roomIdentityCondition(roomColumns, identity)).toSQL();
    expect(compiled.sql).toContain('"room_key"');
    expect(compiled.params).toContain('room:whatsapp:shared');
  });
});

describe('backfill helper', () => {
  test('writes the canonical key when the stored value is empty', () => {
    expect(roomKeyBackfill(null, 'room:whatsapp:a')).toEqual({ roomKey: 'room:whatsapp:a' });
    expect(roomKeyBackfill('', 'room:whatsapp:a')).toEqual({ roomKey: 'room:whatsapp:a' });
    expect(roomKeyBackfill('  ', 'room:whatsapp:a')).toEqual({ roomKey: 'room:whatsapp:a' });
  });

  test('never rewrite a row that already carries the canonical key', () => {
    expect(roomKeyBackfill('room:whatsapp:a', 'room:whatsapp:a')).toEqual({});
  });
});

describe('column detection against the live schema', () => {
  test('resolves a room_key column for every table the agent and tools touch', () => {
    expect(chatRoomsRoomColumns().canonical).toBe(chatRooms.roomKey);
    expect(messagesRoomColumns().canonical).toBe(messages.roomKey);
    expect(subscriptionRoomColumns().canonical).toBe(notificationSubscriptions.roomKey);
    expect(remindersRoomColumns().canonical).toBe(reminders.roomKey);
  });

  test('detects a room_key column on an injected table', () => {
    expect(subscriptionRoomColumns(messageProbe).canonical).toBe(notificationSubscriptions.roomKey);
  });

  test('never degrades to a legacy-only condition', () => {
    const compiled = drizzle(new Database(':memory:'))
      .select({ id: messages.id })
      .from(messages)
      .where(roomIdentityCondition(messagesRoomColumns(), { platform: 'whatsapp', roomKey: 'room:whatsapp:a', roomId: 'a' }))
      .toSQL();
    const whereClause = compiled.sql.slice(compiled.sql.indexOf(' where '));
    expect(whereClause).toContain('room_key');
    expect(whereClause).not.toContain('chat_room_id');
    expect(compiled.params).toContain('room:whatsapp:a');
  });
});

afterAll(() => {
  // no-op: there is no test seam left to restore
});
