/**
 * test/migration.roomKeys.test.ts
 *
 * Migration 0022 (canonical room identity) upgrade behaviour:
 *  - a populated pre-0022 database is backfilled deterministically;
 *  - legacy columns survive so a rollback stays possible;
 *  - ambiguity is recorded in the audit trail instead of being silently dropped;
 *  - new rows keep a room key even before the writing lane is migrated.
 *
 * Every database is created in a temporary directory; the real data directory is
 * never opened.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../src/db/schema';
import { inspectMigrationState, validateSchemaContract } from '../src/db/migrations';
import { findRoomKeyCollisions, getRoomKeyStats } from '../src/db/rooms';
import { ROOT_DIR } from '../src/core/constants';
import { createTempDatabase, type TempDatabase } from './helpers/database';

const MIGRATIONS_DIR = join(ROOT_DIR, 'drizzle/migrations');
const ROOM_KEY_MIGRATION_WHEN = 23;

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

interface LegacyFixture {
  sqlite: Database;
  db: ReturnType<typeof drizzle<typeof schema>>;
  cleanup(): void;
}

/** Migrate a temporary database up to (but not including) the room key migration. */
function createPreRoomKeyDatabase(): LegacyFixture {
  const directory = mkdtempSync(join(tmpdir(), 'elastrax-roomkeys-0021-'));
  temporaryDirectories.push(directory);
  const metaDirectory = join(directory, 'meta');
  mkdirSync(metaDirectory);

  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'));
  const entries = (journal.entries as Array<{ tag: string }>).filter(
    entry => entry.tag !== '0022_room_keys',
  );
  writeFileSync(join(metaDirectory, '_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    cpSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
  }

  const sqlite = new Database(':memory:', { create: true, strict: true });
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: directory });
  return {
    sqlite,
    db,
    cleanup() {
      sqlite.close();
    },
  };
}

function seedPreRoomKeyRows(sqlite: Database): void {
  sqlite.exec(`
    INSERT INTO chat_rooms (id, platform, language, temperature, created_at)
      VALUES ('6281234567890@s.whatsapp.net', 'whatsapp', 'en', 0.6, 1000);
    INSERT INTO chat_rooms (id, platform, language, created_at)
      VALUES ('123456789012345678', 'discord', 'en', 2000);
    INSERT INTO messages (chat_room_id, platform, provider_message_id, sender_id, sender_name, role, content, created_at)
      VALUES ('6281234567890@s.whatsapp.net', 'whatsapp', 'provider-1', 'sender', 'Sender', 'user', 'hello', 1001);
    INSERT INTO reminders (chat_room_id, sender_id, sender_name, message, remind_at, is_sent, platform, created_at)
      VALUES ('6281234567890@s.whatsapp.net', 'sender', 'Sender', 'remind me', 2000, 0, 'whatsapp', 1002);
    INSERT INTO notification_subscriptions (user_id, platform, service_type, chat_room_id, created_at)
      VALUES ('watcher', 'whatsapp', 'jellyfin', '6281234567890@s.whatsapp.net', 1003);
    INSERT INTO message_inbox (platform, chat_room_id, provider_message_id, event_key, received_at, available_at, created_at, updated_at)
      VALUES ('whatsapp', '6281234567890@s.whatsapp.net', 'provider-1', 'event-1', 1000, 1000, 1000, 1000);
    INSERT INTO message_outbox (id, platform, chat_room_id, idempotency_key, payload, available_at, created_at, updated_at)
      VALUES ('outbox-1', 'whatsapp', '6281234567890@s.whatsapp.net', 'reply-1', '{}', 1000, 1000, 1000);
    INSERT INTO scheduled_deliveries (id, platform, job_key, chat_room_id, payload, scheduled_at, available_at, created_at, updated_at)
      VALUES ('scheduled-1', 'whatsapp', 'digest:2026-01-01', '6281234567890@s.whatsapp.net', '{}', 5000, 5000, 1000, 1000);
    INSERT INTO user_roles (user_id, platform, scope, role, granted_by, created_at)
      VALUES ('sender', 'whatsapp', '6281234567890@s.whatsapp.net', 'admin', 'owner', 1004);
    INSERT INTO user_roles (user_id, platform, scope, role, granted_by, created_at)
      VALUES ('sender', 'whatsapp', 'global', 'user', 'owner', 1005);
    INSERT INTO flow_sessions (id, data, updated_at) VALUES ('whatsapp:sender', '{}', 1006);
  `);
}

function columnNames(sqlite: Database, table: string): string[] {
  return (sqlite.query<{ name: string }, [string]>(`SELECT name FROM pragma_table_xinfo(?) ORDER BY cid`).all(table) as Array<{
    name: string;
  }>).map(row => row.name);
}

function roomKeyOf(sqlite: Database, sql: string): string | null {
  return sqlite.query<{ room_key: string | null }, []>(sql).get()?.room_key ?? null;
}

describe('migration 0022 canonical room identity', () => {
  test('is the newest journal entry and is applied last', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const last = journal.entries.at(-1)!;
    expect(last.tag).toBe('0022_room_keys');
    expect(last.when).toBe(ROOM_KEY_MIGRATION_WHEN);
    expect(journal.entries.filter(entry => entry.tag === '0022_room_keys')).toHaveLength(1);
    expect(new Set(journal.entries.map(entry => entry.when)).size).toBe(journal.entries.length);
  });

  test('extends the drizzle snapshot chain', () => {
    const metaDirectory = join(MIGRATIONS_DIR, 'meta');
    const snapshot0021 = JSON.parse(readFileSync(join(metaDirectory, '0021_snapshot.json'), 'utf8'));
    const snapshot0022 = JSON.parse(readFileSync(join(metaDirectory, '0022_snapshot.json'), 'utf8'));
    expect(snapshot0022.prevId).toBe(snapshot0021.id);
    expect(snapshot0022.tables.room_keys).toBeDefined();
    expect(snapshot0022.tables.room_key_conflicts).toBeDefined();
    expect(snapshot0022.tables.chat_rooms.columns.room_key).toBeDefined();
    expect(snapshot0022.tables.user_roles.columns.scope_room_key).toBeDefined();
  });

  test('backfills a populated pre-0022 database deterministically', () => {
    const legacy = createPreRoomKeyDatabase();
    try {
      expect(
        inspectMigrationState(legacy.sqlite, MIGRATIONS_DIR).pending.map(entry => entry.tag),
      ).toEqual(['0022_room_keys']);
      seedPreRoomKeyRows(legacy.sqlite);
      expect(columnNames(legacy.sqlite, 'chat_rooms')).not.toContain('room_key');

      migrate(legacy.db, { migrationsFolder: MIGRATIONS_DIR });
      validateSchemaContract(legacy.sqlite);
      expect(inspectMigrationState(legacy.sqlite, MIGRATIONS_DIR).pending).toHaveLength(0);

      const waKey = 'room:whatsapp:6281234567890@s.whatsapp.net';
      const discordKey = 'room:discord:123456789012345678';
      expect(roomKeyOf(legacy.sqlite, `SELECT room_key FROM chat_rooms WHERE id = '6281234567890@s.whatsapp.net'`)).toBe(waKey);
      expect(roomKeyOf(legacy.sqlite, `SELECT room_key FROM chat_rooms WHERE id = '123456789012345678'`)).toBe(discordKey);
      expect(roomKeyOf(legacy.sqlite, 'SELECT room_key FROM messages')).toBe(waKey);
      expect(roomKeyOf(legacy.sqlite, 'SELECT room_key FROM reminders')).toBe(waKey);
      expect(roomKeyOf(legacy.sqlite, 'SELECT room_key FROM notification_subscriptions')).toBe(waKey);
      expect(roomKeyOf(legacy.sqlite, 'SELECT room_key FROM message_inbox')).toBe(waKey);
      expect(roomKeyOf(legacy.sqlite, 'SELECT room_key FROM message_outbox')).toBe(waKey);
      expect(roomKeyOf(legacy.sqlite, 'SELECT room_key FROM scheduled_deliveries')).toBe(waKey);
      expect(
        roomKeyOf(
          legacy.sqlite,
          "SELECT scope_room_key AS room_key FROM user_roles WHERE scope = '6281234567890@s.whatsapp.net'",
        ),
      ).toBe(waKey);
      // Global scopes and user-scoped flow sessions legitimately have no room key.
      expect(
        roomKeyOf(legacy.sqlite, "SELECT scope_room_key AS room_key FROM user_roles WHERE scope = 'global'"),
      ).toBeNull();
      expect(roomKeyOf(legacy.sqlite, 'SELECT room_key FROM flow_sessions')).toBeNull();

      const registry = legacy.sqlite
        .query<{ room_key: string; legacy_room_id: string | null; created_at: number }, []>(
          'SELECT room_key, legacy_room_id, created_at FROM room_keys ORDER BY room_key',
        )
        .all();
      expect(registry.map(row => row.room_key)).toEqual([discordKey, waKey]);
      expect(registry.every(row => row.legacy_room_id !== null)).toBe(true);
      expect(registry.every(row => row.created_at > 0)).toBe(true);

      const stats = getRoomKeyStats(legacy.sqlite);
      expect(stats.coverageIsComplete).toBe(true);
      expect(stats.unregisteredChatRooms).toBe(0);
      expect(findRoomKeyCollisions(legacy.sqlite)).toEqual([]);
      expect(legacy.sqlite.query('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      legacy.cleanup();
    }
  });

  test('keeps every legacy column so a rollback stays possible', () => {
    const legacy = createPreRoomKeyDatabase();
    try {
      seedPreRoomKeyRows(legacy.sqlite);
      migrate(legacy.db, { migrationsFolder: MIGRATIONS_DIR });

      expect(columnNames(legacy.sqlite, 'chat_rooms')).toContain('id');
      expect(columnNames(legacy.sqlite, 'messages')).toEqual(expect.arrayContaining(['chat_room_id', 'room_key']));
      expect(columnNames(legacy.sqlite, 'reminders')).toEqual(expect.arrayContaining(['chat_room_id', 'room_key']));
      expect(columnNames(legacy.sqlite, 'notification_subscriptions')).toEqual(
        expect.arrayContaining(['chat_room_id', 'room_key']),
      );
      expect(columnNames(legacy.sqlite, 'message_inbox')).toEqual(expect.arrayContaining(['chat_room_id', 'room_key']));
      expect(columnNames(legacy.sqlite, 'message_outbox')).toEqual(expect.arrayContaining(['chat_room_id', 'room_key']));
      expect(columnNames(legacy.sqlite, 'scheduled_deliveries')).toEqual(
        expect.arrayContaining(['chat_room_id', 'room_key']),
      );
      expect(columnNames(legacy.sqlite, 'user_roles')).toEqual(expect.arrayContaining(['scope', 'scope_room_key']));

      // No row was dropped or rebuilt.
      const counts = legacy.sqlite
        .query<{ chat_rooms: number; messages: number; reminders: number }, []>(
          `SELECT
             (SELECT count(*) FROM chat_rooms) AS chat_rooms,
             (SELECT count(*) FROM messages) AS messages,
             (SELECT count(*) FROM reminders) AS reminders`,
        )
        .get();
      expect(counts).toEqual({ chat_rooms: 2, messages: 1, reminders: 1 });
    } finally {
      legacy.cleanup();
    }
  });

  test('refuses a registry row that would steal another room legacy id', () => {
    const legacy = createPreRoomKeyDatabase();
    try {
      seedPreRoomKeyRows(legacy.sqlite);
      migrate(legacy.db, { migrationsFolder: MIGRATIONS_DIR });

      // The partial unique index on (platform, legacy_room_id) makes a stolen
      // legacy id impossible, so the ambiguity is prevented rather than recorded.
      expect(() =>
        legacy.sqlite
          .query<never, [string, string, string, string, number]>(
            `INSERT INTO room_keys (room_key, platform, remote_room_id, legacy_room_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run('room:whatsapp:reassigned', 'whatsapp', 'reassigned', '6281234567890@s.whatsapp.net', 1),
      ).toThrow('UNIQUE constraint failed');
      expect(
        legacy.sqlite
          .query<{ count: number }, [string, string]>(
            'SELECT count(*) AS count FROM room_keys WHERE platform = ? AND legacy_room_id = ?',
          )
          .get('whatsapp', '6281234567890@s.whatsapp.net')?.count,
      ).toBe(1);
    } finally {
      legacy.cleanup();
    }
  });

  test('reports swapped, unknown, and diverged room identities', () => {
    const legacy = createPreRoomKeyDatabase();
    try {
      seedPreRoomKeyRows(legacy.sqlite);
      migrate(legacy.db, { migrationsFolder: MIGRATIONS_DIR });

      legacy.sqlite.exec(`INSERT INTO chat_rooms (id, platform, created_at) VALUES ('corrupt-y', 'whatsapp', 3000);`);
      legacy.sqlite.exec(`INSERT INTO chat_rooms (id, platform, created_at) VALUES ('corrupt-x', 'whatsapp', 3001);`);
      // Rename one row out of the way, then point the other at its derived key so
      // the two registry rows disagree about which key the room owns.
      legacy.sqlite.exec(
        `UPDATE room_keys SET room_key = 'room:whatsapp:corrupt-xy' WHERE remote_room_id = 'corrupt-y'`,
      );
      legacy.sqlite.exec(
        `UPDATE room_keys SET room_key = 'room:whatsapp:corrupt-y' WHERE remote_room_id = 'corrupt-x'`,
      );
      // A message that no longer agrees with its room.
      legacy.sqlite.exec(
        `UPDATE messages SET room_key = 'room:discord:123456789012345678' WHERE chat_room_id = '6281234567890@s.whatsapp.net'`,
      );
      // A room-scoped role that resolves to no registered room.
      legacy.sqlite.exec(`
        INSERT INTO user_roles (user_id, platform, scope, role, granted_by, created_at)
          VALUES ('sender', 'whatsapp', 'ghost-room', 'user', 'owner', 1007);
      `);

      const collisions = findRoomKeyCollisions(legacy.sqlite);
      const kinds = new Set(collisions.map(collision => collision.kind));
      expect(kinds).toContain('room_key_not_transparent');
      expect(kinds).toContain('room_key_taken');
      expect(kinds).toContain('unregistered_chat_room');
      expect(kinds).toContain('room_key_mismatch');
      expect(kinds).toContain('unresolved_scope');

      const stats = getRoomKeyStats(legacy.sqlite);
      expect(stats.unregisteredChatRooms).toBe(1);
      expect(stats.nonTransparentRoomKeys).toBe(2);
      expect(stats.derivedKeyCollisions).toBe(1);
      // Every row still carries a key, so coverage is complete even though the
      // identities themselves are inconsistent.
      expect(stats.coverageIsComplete).toBe(true);
      // The audit trail is read-only: re-running the report adds nothing.
      const before = stats.conflicts;
      findRoomKeyCollisions(legacy.sqlite);
      expect(getRoomKeyStats(legacy.sqlite).conflicts).toBe(before);
    } finally {
      legacy.cleanup();
    }
  });

  test('installs the canonical uniqueness guarantees', () => {
    const database: TempDatabase = createTempDatabase();
    try {
      const indexes = database.sqlite
        .query<{ name: string; sql: string | null }, []>(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('chat_rooms','notification_subscriptions') ORDER BY name",
        )
        .all();
      const byName = new Map(indexes.map(index => [index.name, index.sql ?? '']));
      expect(byName.get('chat_rooms_room_key_unique_idx')).toContain('UNIQUE');
      expect(byName.get('chat_rooms_room_key_unique_idx')).toContain('`room_key`) WHERE `room_key` IS NOT NULL');
      expect(byName.get('notification_subs_room_key_unique_idx')).toContain('UNIQUE');
      expect(byName.get('notification_subs_room_key_unique_idx')).toContain(
        '(`user_id`,`platform`,`service_type`,`room_key`) WHERE `room_key` IS NOT NULL',
      );
      expect(byName.get('notification_subs_room_key_idx')).toContain('(`room_key`)');
      // validateSchemaContract fails when either unique index is missing.
      expect(() => validateSchemaContract(database.sqlite)).not.toThrow();
    } finally {
      database.cleanup();
    }
  });

  test('collapses alias duplicates instead of failing the upgrade', () => {
    const legacy = createPreRoomKeyDatabase();
    try {
      // A partially migrated writer already stored the canonical key of room
      // `alias-room` in its legacy column, so both rows backfill to one key.
      legacy.sqlite.exec(`
        INSERT INTO chat_rooms (id, platform, created_at) VALUES ('alias-room', 'whatsapp', 1000);
        INSERT INTO chat_rooms (id, platform, created_at) VALUES ('plain-room', 'whatsapp', 1001);
        INSERT INTO message_inbox (platform, chat_room_id, event_key, received_at, available_at, created_at, updated_at)
          VALUES ('whatsapp', 'room:whatsapp:alias-room', 'event-keyed', 1000, 1000, 1000, 1000);
        INSERT INTO notification_subscriptions (user_id, platform, service_type, chat_room_id, created_at)
          VALUES ('watcher', 'whatsapp', 'jellyfin', 'alias-room', 1000);
        INSERT INTO notification_subscriptions (user_id, platform, service_type, chat_room_id, created_at)
          VALUES ('watcher', 'whatsapp', 'jellyfin', 'room:whatsapp:alias-room', 1001);
      `);

      migrate(legacy.db, { migrationsFolder: MIGRATIONS_DIR });
      validateSchemaContract(legacy.sqlite);

      // The canonical key stored in the legacy column is adopted, never re-prefixed.
      expect(roomKeyOf(legacy.sqlite, "SELECT room_key FROM message_inbox WHERE event_key = 'event-keyed'"))
        .toBe('room:whatsapp:alias-room');
      expect(
        legacy.sqlite
          .query<{ count: number }, []>("SELECT count(*) AS count FROM room_keys WHERE room_key LIKE '%room:whatsapp:room:%'")
          .get()?.count,
      ).toBe(0);

      // Both rooms keep distinct keys and the duplicate subscription is audited.
      const rooms = legacy.sqlite
        .query<{ id: string; room_key: string | null }, []>('SELECT id, room_key FROM chat_rooms ORDER BY id')
        .all();
      expect(rooms).toEqual([
        { id: 'alias-room', room_key: 'room:whatsapp:alias-room' },
        { id: 'plain-room', room_key: 'room:whatsapp:plain-room' },
      ]);
      const subscriptions = legacy.sqlite
        .query<{ chat_room_id: string; room_key: string | null }, []>(
          'SELECT chat_room_id, room_key FROM notification_subscriptions ORDER BY id',
        )
        .all();
      expect(subscriptions).toEqual([
        { chat_room_id: 'alias-room', room_key: 'room:whatsapp:alias-room' },
        { chat_room_id: 'room:whatsapp:alias-room', room_key: null },
      ]);
      const conflicts = legacy.sqlite
        .query<{ conflict_type: string }, []>(
          "SELECT conflict_type FROM room_key_conflicts WHERE conflict_type = 'duplicate_subscription_room_key'",
        )
        .all();
      expect(conflicts).toHaveLength(1);

      // The new uniqueness guarantees hold after the upgrade.
      expect(() =>
        legacy.sqlite
          .query<never, [string, string, string, number]>(
            `INSERT INTO chat_rooms (id, platform, room_key, created_at) VALUES (?, ?, ?, ?)`,
          )
          .run('impostor', 'whatsapp', 'room:whatsapp:alias-room', 2000),
      ).toThrow('UNIQUE constraint failed: chat_rooms.room_key');
    } finally {
      legacy.cleanup();
    }
  });

  test('accepts a V8.1 room whose id is already its canonical key', () => {
    const legacy = createPreRoomKeyDatabase();
    try {
      legacy.sqlite.exec(`
        INSERT INTO chat_rooms (id, platform, created_at) VALUES ('room:discord:5150', 'discord', 1000);
        INSERT INTO chat_rooms (id, platform, created_at) VALUES ('raw-room', 'discord', 1001);
      `);

      migrate(legacy.db, { migrationsFolder: MIGRATIONS_DIR });

      const rooms = legacy.sqlite
        .query<{ id: string; room_key: string | null }, []>('SELECT id, room_key FROM chat_rooms ORDER BY id')
        .all();
      expect(rooms).toEqual([
        { id: 'raw-room', room_key: 'room:discord:raw-room' },
        { id: 'room:discord:5150', room_key: 'room:discord:5150' },
      ]);
      expect(
        legacy.sqlite
          .query<{ count: number }, []>("SELECT count(*) AS count FROM room_keys WHERE room_key LIKE 'room:discord:room:%'")
          .get()?.count,
      ).toBe(0);
      // A row whose id is its key is a valid V8.1 shape, not an audit finding.
      expect(legacy.sqlite.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM room_key_conflicts WHERE conflict_type = 'chat_room_key_not_transparent'",
      ).get()?.count).toBe(0);
      expect(findRoomKeyCollisions(legacy.sqlite)).toEqual([]);
    } finally {
      legacy.cleanup();
    }
  });

  test('gives rows written after the migration a room key', () => {
    const legacy = createPreRoomKeyDatabase();
    try {
      migrate(legacy.db, { migrationsFolder: MIGRATIONS_DIR });
      legacy.sqlite.exec(`
        INSERT INTO chat_rooms (id, platform, created_at) VALUES ('6281234567890@s.whatsapp.net', 'whatsapp', 1000);
        INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, created_at)
          VALUES ('6281234567890@s.whatsapp.net', 'sender', 'Sender', 'user', 'after', 1001);
        INSERT INTO reminders (chat_room_id, sender_id, sender_name, message, remind_at, is_sent, platform, created_at)
          VALUES ('6281234567890@s.whatsapp.net', 'sender', 'Sender', 'later', 2000, 0, 'whatsapp', 1002);
        INSERT INTO notification_subscriptions (user_id, platform, service_type, chat_room_id, created_at)
          VALUES ('watcher', 'whatsapp', 'jellyfin', '6281234567890@s.whatsapp.net', 1003);
        INSERT INTO message_inbox (platform, chat_room_id, event_key, received_at, available_at, created_at, updated_at)
          VALUES ('whatsapp', '6281234567890@s.whatsapp.net', 'event-1', 1000, 1000, 1000, 1000);
        INSERT INTO message_outbox (id, platform, chat_room_id, idempotency_key, payload, available_at, created_at, updated_at)
          VALUES ('outbox-1', 'whatsapp', '6281234567890@s.whatsapp.net', 'reply-1', '{}', 1000, 1000, 1000);
        INSERT INTO scheduled_deliveries (id, platform, job_key, chat_room_id, payload, scheduled_at, available_at, created_at, updated_at)
          VALUES ('scheduled-1', 'whatsapp', 'digest:2026-01-01', '6281234567890@s.whatsapp.net', '{}', 5000, 5000, 1000, 1000);
        -- A queue row for a room that was never registered still gets a stable key.
        INSERT INTO message_inbox (platform, chat_room_id, event_key, received_at, available_at, created_at, updated_at)
          VALUES ('discord', '999999999999999999', 'event-2', 1000, 1000, 1000, 1000);
      `);

      const waKey = 'room:whatsapp:6281234567890@s.whatsapp.net';
      expect(roomKeyOf(legacy.sqlite, 'SELECT room_key FROM messages')).toBe(waKey);
      expect(roomKeyOf(legacy.sqlite, 'SELECT room_key FROM reminders')).toBe(waKey);
      expect(roomKeyOf(legacy.sqlite, 'SELECT room_key FROM notification_subscriptions')).toBe(waKey);
      expect(
        roomKeyOf(legacy.sqlite, "SELECT room_key FROM message_inbox WHERE event_key = 'event-1'"),
      ).toBe(waKey);
      expect(roomKeyOf(legacy.sqlite, 'SELECT room_key FROM message_outbox')).toBe(waKey);
      expect(roomKeyOf(legacy.sqlite, 'SELECT room_key FROM scheduled_deliveries')).toBe(waKey);
      expect(
        roomKeyOf(legacy.sqlite, "SELECT room_key FROM message_inbox WHERE event_key = 'event-2'"),
      ).toBe('room:discord:999999999999999999');
      // An explicitly supplied key is never overwritten.
      legacy.sqlite.exec(`
        INSERT INTO chat_rooms (id, platform, room_key, created_at) VALUES ('discord-room', 'discord', 'room:discord:discord-room', 1000);
      `);
      expect(roomKeyOf(legacy.sqlite, "SELECT room_key FROM chat_rooms WHERE id = 'discord-room'")).toBe(
        'room:discord:discord-room',
      );
    } finally {
      legacy.cleanup();
    }
  });

  test('applies cleanly on a fresh database and validates the schema contract', () => {
    const database: TempDatabase = createTempDatabase();
    try {
      validateSchemaContract(database.sqlite);
      expect(inspectMigrationState(database.sqlite, MIGRATIONS_DIR).applied).toHaveLength(ROOM_KEY_MIGRATION_WHEN);
      const stats = getRoomKeyStats(database.sqlite);
      expect(stats.roomKeys).toBe(0);
      expect(stats.conflicts).toBe(0);
      expect(stats.coverageIsComplete).toBe(true);
      expect(findRoomKeyCollisions(database.sqlite)).toEqual([]);
    } finally {
      database.cleanup();
    }
  });
});
