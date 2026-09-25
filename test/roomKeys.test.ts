/**
 * test/roomKeys.test.ts
 *
 * Canonical room identity: deterministic transparent keys, registry resolution,
 * and the read-only coverage/collision reporting used by scripts/dbRoomKeys.ts.
 *
 * Every test uses a temporary database; the real data directory is never opened.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  ROOM_KEY_MIGRATION_TAG,
  ROOM_KEY_MIGRATION_WHEN,
  ROOM_KEY_PREFIX,
  RoomKeyMismatchError,
  assertRoomKeyMatches,
  findRoomKeyCollisions,
  getRoomKeyStats,
  isCanonicalRoomKey,
  parseRoomKey,
  resolveOrCreateRoomKey,
  resolveOrCreateRoomKeySync,
  resolveRoomKey,
  resolveRoomKeySync,
  toRoomKey,
} from '../src/db/rooms';
import { createTempDatabase, type TempDatabase } from './helpers/database';

const WA_ROOM = '6281234567890@s.whatsapp.net';
const DISCORD_ROOM = '123456789012345678';
const SHARED_REMOTE_ID = 'shared-room';

let database: TempDatabase;
let sqlite: Database;

function roomKeyFor(platform: string, remoteRoomId: string, handle: Database): string | null {
  return handle
    .query<{ room_key: string | null }, [string, string, string]>(
      'SELECT room_key FROM chat_rooms WHERE platform = ? AND (id = ? OR room_key = ?)',
    )
    .get(platform, remoteRoomId, toRoomKey(platform, remoteRoomId))?.room_key ?? null;
}

function roomKeyOf(table: string, eventKey: string): string | null {
  return (
    sqlite
      .query<{ room_key: string | null }, [string, string]>(
        `SELECT room_key FROM ${table} WHERE event_key = ? AND platform = ?`,
      )
      .get(eventKey, 'whatsapp')?.room_key ?? null
  );
}

beforeEach(() => {
  database = createTempDatabase();
  sqlite = database.sqlite;
});

afterEach(() => {
  database.cleanup();
});

describe('room key format', () => {
  test('builds deterministic transparent keys', () => {
    expect(ROOM_KEY_PREFIX).toBe('room:');
    expect(toRoomKey('whatsapp', WA_ROOM)).toBe(`room:whatsapp:${WA_ROOM}`);
    expect(toRoomKey('discord', DISCORD_ROOM)).toBe(`room:discord:${DISCORD_ROOM}`);
    expect(toRoomKey('whatsapp', WA_ROOM)).toBe(toRoomKey('whatsapp', WA_ROOM));
  });

  test('is platform scoped so the same remote id yields distinct keys', () => {
    expect(toRoomKey('whatsapp', SHARED_REMOTE_ID)).not.toBe(toRoomKey('discord', SHARED_REMOTE_ID));
  });

  test('trims surrounding whitespace and rejects unusable input', () => {
    expect(toRoomKey(' whatsapp ', ` ${WA_ROOM} `)).toBe(toRoomKey('whatsapp', WA_ROOM));
    expect(() => toRoomKey('', WA_ROOM)).toThrow('platform must not be empty');
    expect(() => toRoomKey('whatsapp', '   ')).toThrow('remoteRoomId must not be empty');
    expect(() => toRoomKey('whatsapp', 'bad\u0000id')).toThrow('control characters');
    expect(() => toRoomKey(42 as unknown as string, WA_ROOM)).toThrow('platform must be a string');
  });

  test('round-trips through parseRoomKey', () => {
    expect(parseRoomKey(toRoomKey('discord', DISCORD_ROOM))).toEqual({
      platform: 'discord',
      remoteRoomId: DISCORD_ROOM,
    });
    expect(parseRoomKey('room::missing-platform')).toBeNull();
    expect(parseRoomKey('room:discord:')).toBeNull();
    expect(parseRoomKey('discord:123')).toBeNull();
    expect(parseRoomKey('legacy-id')).toBeNull();
    expect(parseRoomKey(null)).toBeNull();
  });

  test('recognises only the exact canonical key for a pair', () => {
    expect(isCanonicalRoomKey('whatsapp', WA_ROOM, toRoomKey('whatsapp', WA_ROOM))).toBe(true);
    expect(isCanonicalRoomKey('whatsapp', WA_ROOM, toRoomKey('discord', WA_ROOM))).toBe(false);
    expect(isCanonicalRoomKey('whatsapp', WA_ROOM, null)).toBe(false);
  });
});

describe('room key registry', () => {
  test('resolves an unknown room as null and creates it on demand', async () => {
    expect(await resolveRoomKey('whatsapp', WA_ROOM, sqlite)).toBeNull();

    const created = await resolveOrCreateRoomKey('whatsapp', WA_ROOM, { sqlite, now: 1_000 });
    expect(created).toBe(`room:whatsapp:${WA_ROOM}`);
    expect(await resolveRoomKey('whatsapp', WA_ROOM, sqlite)).toBe(created);
    expect(sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM room_keys').get()?.count).toBe(1);
  });

  test('registration is idempotent and returns the same key every time', async () => {
    const first = await resolveOrCreateRoomKey('discord', DISCORD_ROOM, { sqlite, now: 1_000 });
    const second = await resolveOrCreateRoomKey('discord', DISCORD_ROOM, { sqlite, now: 2_000 });
    const sync = resolveOrCreateRoomKeySync('discord', DISCORD_ROOM, { sqlite, now: 3_000 });
    expect(second).toBe(first);
    expect(sync.roomKey).toBe(first);
    expect(sync.created).toBe(false);
    expect(sync.legacyRoomId).toBeNull();
    expect(sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM room_keys').get()?.count).toBe(1);
  });

  test('keeps the same remote id on two platforms in separate rooms', async () => {
    const wa = await resolveOrCreateRoomKey('whatsapp', SHARED_REMOTE_ID, { sqlite, now: 1_000 });
    const discord = await resolveOrCreateRoomKey('discord', SHARED_REMOTE_ID, { sqlite, now: 1_000 });
    expect(wa).not.toBe(discord);
    expect(await resolveRoomKey('whatsapp', SHARED_REMOTE_ID, sqlite)).toBe(wa);
    expect(await resolveRoomKey('discord', SHARED_REMOTE_ID, sqlite)).toBe(discord);
    expect(sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM room_keys').get()?.count).toBe(2);
  });

  test('resolves a registered room and links the legacy chat_rooms id', () => {
    sqlite.exec(`
      INSERT INTO chat_rooms (id, platform, created_at) VALUES ('${WA_ROOM}', 'whatsapp', 1000);
    `);

    const resolved = resolveOrCreateRoomKeySync('whatsapp', WA_ROOM, { sqlite, now: 5_000 });
    expect(resolved.roomKey).toBe(`room:whatsapp:${WA_ROOM}`);
    expect(resolved.legacyRoomId).toBe(WA_ROOM);
    expect(resolveRoomKeySync('whatsapp', WA_ROOM, sqlite)).toBe(`room:whatsapp:${WA_ROOM}`);

    const row = sqlite
      .query<{ legacy_room_id: string | null; room_key: string }, [string, string]>(
        'SELECT legacy_room_id, room_key FROM room_keys WHERE platform = ? AND remote_room_id = ?',
      )
      .get('whatsapp', WA_ROOM);
    expect(row?.legacy_room_id).toBe(WA_ROOM);
    expect(row?.room_key).toBe(`room:whatsapp:${WA_ROOM}`);
  });

  test('chat_rooms inserts register a room key without any application call', () => {
    sqlite.exec(`
      INSERT INTO chat_rooms (id, platform, created_at) VALUES ('${WA_ROOM}', 'whatsapp', 1000);
    `);

    const room = sqlite
      .query<{ room_key: string | null }, [string]>('SELECT room_key FROM chat_rooms WHERE id = ?')
      .get(WA_ROOM);
    expect(room?.room_key).toBe(`room:whatsapp:${WA_ROOM}`);
    expect(resolveRoomKeySync('whatsapp', WA_ROOM, sqlite)).toBe(`room:whatsapp:${WA_ROOM}`);
  });

  test('a room key is never taken from another platform', () => {
    sqlite.exec(`
      INSERT INTO chat_rooms (id, platform, created_at) VALUES ('${SHARED_REMOTE_ID}', 'whatsapp', 1000);
    `);
    resolveOrCreateRoomKeySync('discord', SHARED_REMOTE_ID, { sqlite, now: 1_000 });

    const samePlatform = sqlite
      .query<{ count: number }, [string, string]>(
        'SELECT count(*) AS count FROM room_keys WHERE platform = ? AND remote_room_id = ?',
      )
      .get('whatsapp', SHARED_REMOTE_ID)?.count;
    const otherPlatform = sqlite
      .query<{ count: number }, [string, string]>(
        'SELECT count(*) AS count FROM room_keys WHERE platform = ? AND remote_room_id = ?',
      )
      .get('discord', SHARED_REMOTE_ID)?.count;
    expect(samePlatform).toBe(1);
    expect(otherPlatform).toBe(1);
  });

  test('the registry keeps its uniqueness guarantees', () => {
    sqlite.exec(`
      INSERT INTO chat_rooms (id, platform, created_at) VALUES ('${WA_ROOM}', 'whatsapp', 1000);
    `);
    resolveOrCreateRoomKeySync('whatsapp', WA_ROOM, { sqlite, now: 1_000 });
    expect(() =>
      sqlite.exec(
        `INSERT INTO room_keys (room_key, platform, remote_room_id, legacy_room_id, created_at)
         VALUES ('room:whatsapp:other', 'whatsapp', '${WA_ROOM}', NULL, 1)`,
      ),
    ).toThrow();
    expect(() =>
      sqlite.exec(
        `INSERT INTO room_keys (room_key, platform, remote_room_id, legacy_room_id, created_at)
         VALUES ('room:whatsapp:other', 'whatsapp', 'other', '${WA_ROOM}', 1)`,
      ),
    ).toThrow();
    // A NULL legacy id never participates in the partial unique index.
    expect(() =>
      sqlite.exec(
        `INSERT INTO room_keys (room_key, platform, remote_room_id, legacy_room_id, created_at)
         VALUES ('room:whatsapp:unlinked', 'whatsapp', 'unlinked', NULL, 1)`,
      ),
    ).not.toThrow();
  });
});

describe('assertRoomKeyMatches', () => {
  test('accepts the canonical key and rejects anything else', async () => {
    await resolveOrCreateRoomKey('whatsapp', WA_ROOM, { sqlite, now: 1_000 });

    expect(assertRoomKeyMatches('whatsapp', WA_ROOM, `room:whatsapp:${WA_ROOM}`, { sqlite })).toBe(true);
    expect(() => assertRoomKeyMatches('whatsapp', WA_ROOM, `room:discord:${WA_ROOM}`, { sqlite }))
      .toThrow(RoomKeyMismatchError);
    expect(() => assertRoomKeyMatches('whatsapp', WA_ROOM, null, { sqlite })).toThrow('room key is missing');
    expect(() => assertRoomKeyMatches('whatsapp', WA_ROOM, '  ', { sqlite })).toThrow('room key is missing');
    // An unregistered room has no registry row to disagree with, so the
    // transparency rule is what rejects the stored value.
    expect(() => assertRoomKeyMatches('whatsapp', 'unregistered-room', 'legacy-id', { sqlite }))
      .toThrow('does not encode this platform and remote room id');
  });

  test('detects a registry that disagrees with the derived key', () => {
    sqlite.exec(`
      INSERT INTO room_keys (room_key, platform, remote_room_id, legacy_room_id, created_at)
        VALUES ('room:whatsapp:renamed', 'whatsapp', '${WA_ROOM}', NULL, 1);
    `);
    expect(() => assertRoomKeyMatches('whatsapp', WA_ROOM, `room:whatsapp:${WA_ROOM}`, { sqlite }))
      .toThrow('room_keys holds room:whatsapp:renamed');
  });
});

describe('canonical room uniqueness', () => {
  test('a canonical room key identifies exactly one room', () => {
    sqlite.exec(`
      INSERT INTO chat_rooms (id, platform, created_at) VALUES ('${WA_ROOM}', 'whatsapp', 1000);
    `);
    expect(() =>
      sqlite
        .query<never, [string, string, string | null, number]>(
          `INSERT INTO chat_rooms (id, platform, room_key, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run('other', 'whatsapp', `room:whatsapp:${WA_ROOM}`, 1000),
    ).toThrow('UNIQUE constraint failed: chat_rooms.room_key');

    // A row that starts unresolved still gets its own key, never a shared one.
    expect(() =>
      sqlite
        .query<never, [string, string, string | null, number]>(
          `INSERT INTO chat_rooms (id, platform, room_key, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run('unresolved', 'whatsapp', null, 1000),
    ).not.toThrow();
    const keys = sqlite
      .query<{ room_key: string | null }, []>('SELECT room_key FROM chat_rooms ORDER BY id')
      .all()
      .map(row => row.room_key);
    expect(keys).toEqual([`room:whatsapp:${WA_ROOM}`, 'room:whatsapp:unresolved']);
  });

  test('one subscription target cannot resolve to two room keys', () => {
    sqlite.exec(`
      INSERT INTO notification_subscriptions (user_id, platform, service_type, chat_room_id, room_key, created_at)
        VALUES ('watcher', 'whatsapp', 'jellyfin', '${WA_ROOM}', 'room:whatsapp:${WA_ROOM}', 1000);
    `);
    expect(() =>
      sqlite
        .query<never, [string, string, string, string, string, number]>(
          `INSERT INTO notification_subscriptions (user_id, platform, service_type, chat_room_id, room_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('watcher', 'whatsapp', 'jellyfin', 'alias', `room:whatsapp:${WA_ROOM}`, 1000),
    ).toThrow('UNIQUE constraint failed: notification_subscriptions.user_id, notification_subscriptions.platform, notification_subscriptions.service_type, notification_subscriptions.room_key');
    // A different user, service, or unresolved key is unaffected.
    expect(() =>
      sqlite.exec(`
        INSERT INTO notification_subscriptions (user_id, platform, service_type, chat_room_id, room_key, created_at)
          VALUES ('other', 'whatsapp', 'jellyfin', 'alias', 'room:whatsapp:${WA_ROOM}', 1000);
      `),
    ).not.toThrow();
    expect(() =>
      sqlite.exec(`
        INSERT INTO notification_subscriptions (user_id, platform, service_type, chat_room_id, room_key, created_at)
          VALUES ('watcher', 'seerr', 'jellyfin', 'alias', 'room:whatsapp:${WA_ROOM}', 1000);
      `),
    ).not.toThrow();
    expect(() =>
      sqlite.exec(`
        INSERT INTO notification_subscriptions (user_id, platform, service_type, chat_room_id, room_key, created_at)
          VALUES ('watcher', 'whatsapp', 'jellyfin', 'unresolved', NULL, 1000);
      `),
    ).not.toThrow();
  });
});

describe('explicit room key inserts', () => {
  test('never produce a double-prefixed registry row', () => {
    sqlite.exec(`
      INSERT INTO chat_rooms (id, platform, room_key, created_at)
        VALUES ('room:whatsapp:9999', 'whatsapp', 'room:whatsapp:9999', 1000);
      INSERT INTO chat_rooms (id, platform, room_key, created_at)
        VALUES ('${WA_ROOM}', 'whatsapp', 'room:whatsapp:${WA_ROOM}', 1000);
    `);

    const registry = sqlite
      .query<{ room_key: string; platform: string; remote_room_id: string; legacy_room_id: string | null }, []>(
        'SELECT room_key, platform, remote_room_id, legacy_room_id FROM room_keys ORDER BY room_key',
      )
      .all();
    expect(registry).toEqual([
      { room_key: `room:whatsapp:${WA_ROOM}`, platform: 'whatsapp', remote_room_id: WA_ROOM, legacy_room_id: null },
      { room_key: 'room:whatsapp:9999', platform: 'whatsapp', remote_room_id: '9999', legacy_room_id: null },
    ]);
    expect(
      sqlite
        .query<{ count: number }, []>("SELECT count(*) AS count FROM room_keys WHERE room_key LIKE '%room:room:%'")
        .get()?.count,
    ).toBe(0);
  });

  test('a V8.1 row keyed by id resolves to that key', () => {
    sqlite.exec(`
      INSERT INTO chat_rooms (id, platform, room_key, created_at)
        VALUES ('room:discord:${DISCORD_ROOM}', 'discord', 'room:discord:${DISCORD_ROOM}', 1000);
    `);

    expect(roomKeyFor('discord', DISCORD_ROOM, sqlite)).toBe(`room:discord:${DISCORD_ROOM}`);
    expect(resolveRoomKeySync('discord', DISCORD_ROOM, sqlite)).toBe(`room:discord:${DISCORD_ROOM}`);
    expect(findRoomKeyCollisions(sqlite)).toEqual([]);
    expect(
      sqlite
        .query<{ count: number }, []>("SELECT count(*) AS count FROM room_keys WHERE room_key LIKE 'room:discord:room:%'")
        .get()?.count,
    ).toBe(0);
  });

  test('a canonical id without a room key is adopted instead of re-prefixed', () => {
    sqlite.exec(`INSERT INTO chat_rooms (id, platform, created_at) VALUES ('room:discord:4242', 'discord', 1000);`);

    const room = sqlite
      .query<{ room_key: string | null }, [string]>('SELECT room_key FROM chat_rooms WHERE id = ?')
      .get('room:discord:4242');
    expect(room?.room_key).toBe('room:discord:4242');
    const registry = sqlite
      .query<{ room_key: string; remote_room_id: string; legacy_room_id: string | null }, [string]>(
        'SELECT room_key, remote_room_id, legacy_room_id FROM room_keys WHERE platform = ?',
      )
      .all('discord');
    expect(registry).toEqual([{ room_key: 'room:discord:4242', remote_room_id: '4242', legacy_room_id: null }]);
  });

  test('a non-canonical room key is reported instead of becoming a registry row', () => {
    sqlite.exec(`
      INSERT INTO chat_rooms (id, platform, room_key, created_at) VALUES ('opaque-room', 'whatsapp', 'opaque-key', 1000);
    `);

    // The supplied value is preserved on the row and never enters the registry,
    // while the room still resolves through its own derived key.
    expect(roomKeyFor('whatsapp', 'opaque-room', sqlite)).toBe('opaque-key');
    expect(resolveRoomKeySync('whatsapp', 'opaque-room', sqlite)).toBe('room:whatsapp:opaque-room');
    expect(
      sqlite
        .query<{ count: number }, []>("SELECT count(*) AS count FROM room_keys WHERE room_key = 'opaque-key'")
        .get()?.count,
    ).toBe(0);
    const opaque = findRoomKeyCollisions(sqlite).find(
      collision => collision.kind === 'chat_room_key_not_transparent',
    );
    expect(opaque?.rowId).toBe('opaque-room');
    expect(opaque?.roomKey).toBe('opaque-key');
  });

  test('a cross-platform key in the legacy column is never adopted', () => {
    // A Discord key stored in a WhatsApp inbox row must not become that row's key.
    sqlite.exec(`
      INSERT INTO chat_rooms (id, platform, created_at) VALUES ('${WA_ROOM}', 'whatsapp', 1000);
      INSERT INTO message_inbox (platform, chat_room_id, event_key, received_at, available_at, created_at, updated_at)
        VALUES ('whatsapp', 'room:discord:${DISCORD_ROOM}', 'event-foreign', 1000, 1000, 1000, 1000);
      INSERT INTO message_inbox (platform, chat_room_id, event_key, received_at, available_at, created_at, updated_at)
        VALUES ('whatsapp', 'room:whatsapp:unregistered', 'event-own', 1000, 1000, 1000, 1000);
    `);

    expect(roomKeyOf('message_inbox', 'event-foreign')).toBe('room:whatsapp:room:discord:123456789012345678');
    expect(roomKeyOf('message_inbox', 'event-own')).toBe('room:whatsapp:unregistered');
  });
});

describe('room key coverage reporting', () => {
  test('reports a clean database as fully covered', () => {
    sqlite.exec(`
      INSERT INTO chat_rooms (id, platform, created_at) VALUES ('${WA_ROOM}', 'whatsapp', 1000);
      INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, created_at)
        VALUES ('${WA_ROOM}', 'sender', 'Sender', 'user', 'hello', 1000);
    `);

    const stats = getRoomKeyStats(sqlite);
    expect(stats.roomKeys).toBe(1);
    expect(stats.withLegacyRoomId).toBe(1);
    expect(stats.chatRooms).toBe(1);
    expect(stats.unregisteredChatRooms).toBe(0);
    expect(stats.nonTransparentRoomKeys).toBe(0);
    expect(stats.derivedKeyCollisions).toBe(0);
    expect(stats.coverageIsComplete).toBe(true);
    expect(findRoomKeyCollisions(sqlite)).toEqual([]);

    const messages = stats.coverage.find(entry => entry.table === 'messages');
    expect(messages?.withRoomKey).toBe(1);
    expect(messages?.withoutRoomKey).toBe(0);
    expect(messages?.optional).toBe(false);
  });

  test('flags null coverage, unregistered rooms, and unreadable keys', () => {
    sqlite.exec(`
      INSERT INTO chat_rooms (id, platform, created_at) VALUES ('${WA_ROOM}', 'whatsapp', 1000);
      INSERT INTO room_keys (room_key, platform, remote_room_id, legacy_room_id, created_at)
        VALUES ('opaque-key', 'whatsapp', 'opaque-room', NULL, 1);
    `);
    sqlite.exec(`UPDATE messages SET room_key = NULL WHERE 0;`);
    sqlite.exec(`
      INSERT INTO message_inbox (platform, chat_room_id, event_key, received_at, available_at, created_at, updated_at)
        VALUES ('whatsapp', 'unregistered-room', 'event-1', 1, 1, 1, 1);
    `);

    const stats = getRoomKeyStats(sqlite);
    expect(stats.nonTransparentRoomKeys).toBe(1);
    expect(stats.coverageIsComplete).toBe(true);
    const inbox = stats.coverage.find(entry => entry.table === 'message_inbox');
    expect(inbox?.withRoomKey).toBe(1);

    const kinds = findRoomKeyCollisions(sqlite).map(collision => collision.kind);
    expect(kinds).toContain('room_key_not_transparent');
  });

  test('detects a room that a copy row no longer agrees with', () => {
    sqlite.exec(`
      INSERT INTO chat_rooms (id, platform, created_at) VALUES ('${WA_ROOM}', 'whatsapp', 1000);
      INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, created_at)
        VALUES ('${WA_ROOM}', 'sender', 'Sender', 'user', 'hello', 1000);
    `);
    sqlite.exec(`UPDATE messages SET room_key = 'room:discord:${WA_ROOM}' WHERE chat_room_id = '${WA_ROOM}'`);

    const collisions = findRoomKeyCollisions(sqlite);
    const mismatch = collisions.find(collision => collision.kind === 'room_key_mismatch');
    expect(mismatch?.table).toBe('messages');
    expect(mismatch?.roomKey).toBe(`room:discord:${WA_ROOM}`);
    expect(getRoomKeyStats(sqlite).coverageIsComplete).toBe(true);
  });

  test('records room-scoped roles that resolve to no known room', () => {
    sqlite.exec(`
      INSERT INTO user_roles (user_id, platform, scope, role, granted_by, created_at)
        VALUES ('user', 'whatsapp', 'ghost-room', 'user', 'test', 1000);
      INSERT INTO user_roles (user_id, platform, scope, role, granted_by, created_at)
        VALUES ('user', 'whatsapp', 'global', 'user', 'test', 1000);
    `);

    const kinds = findRoomKeyCollisions(sqlite).map(collision => collision.kind);
    expect(kinds).toContain('unresolved_scope');
    const globalScope = sqlite
      .query<{ scope_room_key: string | null }, []>(
        "SELECT scope_room_key FROM user_roles WHERE scope = 'global'",
      )
      .get();
    expect(globalScope?.scope_room_key).toBeNull();
  });

  test('is read-only: repeated reports never change the database', () => {
    sqlite.exec(`
      INSERT INTO chat_rooms (id, platform, created_at) VALUES ('${WA_ROOM}', 'whatsapp', 1000);
    `);
    const before = sqlite.query<{ page_count: number }, []>('PRAGMA page_count').get()?.page_count;
    const first = getRoomKeyStats(sqlite);
    const firstCollisions = findRoomKeyCollisions(sqlite);
    const second = getRoomKeyStats(sqlite);
    const secondCollisions = findRoomKeyCollisions(sqlite);
    const after = sqlite.query<{ page_count: number }, []>('PRAGMA page_count').get()?.page_count;

    expect(second).toEqual(first);
    expect(secondCollisions).toEqual(firstCollisions);
    expect(after).toBe(before);
  });

  test('reports the migration that introduced the room identity system', () => {
    expect(ROOM_KEY_MIGRATION_TAG).toBe('0022_room_keys');
    expect(ROOM_KEY_MIGRATION_WHEN).toBe(23);
  });
});
