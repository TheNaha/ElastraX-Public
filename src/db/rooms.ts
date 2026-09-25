/**
 * @file src/db/rooms.ts
 * @description Canonical room identity for ElastraX (V8.1, migration 0022).
 *
 * A room key is a deterministic, transparent string:
 *
 *   `room:<platform>:<remoteRoomId>`   e.g. `room:whatsapp:6281234567890@s.whatsapp.net`
 *
 * Because the key is transparent it can always be parsed back into the
 * platform/remote-id pair, so a key is safe to store, log, and compare without a
 * database round trip. The same remote id on two platforms always yields two
 * distinct keys, which is what makes WhatsApp and Discord rooms unambiguous.
 *
 * The `room_keys` table is the registry. It records which legacy `chat_rooms.id`
 * (when one exists) a key was derived from; all legacy `chat_room_id` columns are
 * retained, so any row can still be addressed by its pre-migration identifier.
 *
 * Everything here is additive and safe to call before migration 0022 has been
 * applied: functions that need the registry degrade to the derived key or `null`
 * instead of throwing, and only `assertRoomKeyMatches` throws (by design).
 */

import type { Database } from 'bun:sqlite';
import { withImmediateTransaction } from './runtime';
import { getDefaultDatabase } from './index';
import { ROOM_KEY_MIGRATION_INDEX, ROOM_KEY_MIGRATION_TAG, ROOM_KEY_MIGRATION_WHEN } from './migrations';

/** Canonical prefix of every room key. */
export const ROOM_KEY_PREFIX = 'room:';

export { ROOM_KEY_MIGRATION_INDEX, ROOM_KEY_MIGRATION_TAG, ROOM_KEY_MIGRATION_WHEN };

export interface RoomKeyParts {
  platform: string;
  remoteRoomId: string;
}

export interface RoomKeyStats {
  /** Total registry rows. */
  roomKeys: number;
  /** Registry rows that still carry a legacy `chat_rooms.id`. */
  withLegacyRoomId: number;
  /** Legacy `chat_rooms` rows. */
  chatRooms: number;
  /** Legacy room rows with no registry entry. */
  unregisteredChatRooms: number;
  /** Registry rows whose key does not encode its own platform/remote pair. */
  nonTransparentRoomKeys: number;
  /** Registry rows whose derived key is stored under a different key. */
  derivedKeyCollisions: number;
  /** Audit rows recorded in `room_key_conflicts` / `room_key_collisions`. */
  conflicts: number;
  /** Audit rows that have not been marked resolved. */
  unresolvedConflicts: number;
  /** Per-table `room_key` coverage. */
  coverage: RoomKeyCoverage[];
  /** Flow sessions are user scoped, so a NULL `room_key` is expected there. */
  coverageIsComplete: boolean;
}

export interface RoomKeyCoverage {
  table: string;
  column: string;
  total: number;
  withRoomKey: number;
  withoutRoomKey: number;
  /** True when a NULL value is the expected state for this table. */
  optional: boolean;
}

export interface RoomKeyCollision {
  kind: string;
  detail: string;
  table: string | null;
  rowId: string | null;
  platform: string | null;
  roomKey: string | null;
  remoteRoomId: string | null;
  legacyRoomId: string | null;
}

const MAX_IDENTIFIER_LENGTH = 512;

function trimValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TypeError(`${field} must not be empty`);
  if (trimmed.length > MAX_IDENTIFIER_LENGTH) {
    throw new TypeError(`${field} must be at most ${MAX_IDENTIFIER_LENGTH} characters`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new TypeError(`${field} must not contain control characters`);
  }
  return trimmed;
}

function defaultDatabase(): Database {
  return getDefaultDatabase().sqlite;
}

function tableExists(sqlite: Database, table: string): boolean {
  const row = sqlite
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(table);
  return row !== null;
}

function hasColumn(sqlite: Database, table: string, column: string): boolean {
  if (!tableExists(sqlite, table)) return false;
  const rows = sqlite
    .query<{ name: string }, [string]>('SELECT name FROM pragma_table_xinfo(?) ORDER BY cid')
    .all(table) as Array<{ name: string }>;
  return rows.some(row => row.name === column);
}

/**
 * Build the canonical key for a platform/remote-id pair. Pure, deterministic,
 * and safe to call on hot paths or before the database is ready.
 */
export function toRoomKey(platform: string, remoteRoomId: string): string {
  const normalizedPlatform = trimValue(platform, 'platform');
  const normalizedRemoteRoomId = trimValue(remoteRoomId, 'remoteRoomId');
  return `${ROOM_KEY_PREFIX}${normalizedPlatform}:${normalizedRemoteRoomId}`;
}

/**
 * Parse a room key back into its platform/remote-id pair.
 * Returns `null` for anything that is not a well-formed canonical key.
 */
export function parseRoomKey(roomKey: string | null | undefined): RoomKeyParts | null {
  if (typeof roomKey !== 'string') return null;
  const value = roomKey.trim();
  if (!value.startsWith(ROOM_KEY_PREFIX)) return null;
  const body = value.slice(ROOM_KEY_PREFIX.length);
  const separator = body.indexOf(':');
  if (separator <= 0) return null;
  const platform = body.slice(0, separator);
  const remoteRoomId = body.slice(separator + 1);
  if (platform.length === 0 || remoteRoomId.length === 0) return null;
  return { platform, remoteRoomId };
}

/** True when `roomKey` is exactly the canonical key for this platform/remote pair. */
export function isCanonicalRoomKey(platform: string, remoteRoomId: string, roomKey: string | null | undefined): boolean {
  if (typeof roomKey !== 'string') return false;
  return roomKey === toRoomKey(platform, remoteRoomId);
}

interface RegistryRow {
  room_key: string;
  platform: string;
  remote_room_id: string;
  legacy_room_id: string | null;
  created_at: number;
}

function selectRegistryRow(sqlite: Database, platform: string, remoteRoomId: string): RegistryRow | null {
  return (
    sqlite
      .query<RegistryRow, [string, string]>(
        `SELECT room_key, platform, remote_room_id, legacy_room_id, created_at
         FROM room_keys
         WHERE platform = ? AND remote_room_id = ?`,
      )
      .get(platform, remoteRoomId) ?? null
  );
}

function legacyRoomExists(sqlite: Database, platform: string, remoteRoomId: string): boolean {
  if (!hasColumn(sqlite, 'chat_rooms', 'platform')) return false;
  const row = sqlite
    .query<{ id: string }, [string, string]>(
      'SELECT id FROM chat_rooms WHERE id = ? AND platform = ? LIMIT 1',
    )
    .get(remoteRoomId, platform);
  return row !== null;
}

/**
 * Resolve the canonical key for a platform/remote-id pair.
 *
 * Returns the registered key when the registry knows the room, the canonical
 * key for a room that exists in `chat_rooms` but is not registered yet, and
 * `null` when the room is unknown. Never throws for a missing/unmigrated schema.
 */
export async function resolveRoomKey(
  platform: string,
  remoteRoomId: string,
  sqlite: Database = defaultDatabase(),
): Promise<string | null> {
  const normalizedPlatform = trimValue(platform, 'platform');
  const normalizedRemoteRoomId = trimValue(remoteRoomId, 'remoteRoomId');
  if (!tableExists(sqlite, 'room_keys')) {
    return legacyRoomExists(sqlite, normalizedPlatform, normalizedRemoteRoomId)
      ? toRoomKey(normalizedPlatform, normalizedRemoteRoomId)
      : null;
  }
  const row = selectRegistryRow(sqlite, normalizedPlatform, normalizedRemoteRoomId);
  if (row) return row.room_key;
  return legacyRoomExists(sqlite, normalizedPlatform, normalizedRemoteRoomId)
    ? toRoomKey(normalizedPlatform, normalizedRemoteRoomId)
    : null;
}

/**
 * Synchronous variant of {@link resolveRoomKey} for hot paths (inbox/outbox
 * writers) that must not await. Same semantics, no promise allocation.
 */
export function resolveRoomKeySync(
  platform: string,
  remoteRoomId: string,
  sqlite: Database = defaultDatabase(),
): string | null {
  const normalizedPlatform = trimValue(platform, 'platform');
  const normalizedRemoteRoomId = trimValue(remoteRoomId, 'remoteRoomId');
  if (!tableExists(sqlite, 'room_keys')) {
    return legacyRoomExists(sqlite, normalizedPlatform, normalizedRemoteRoomId)
      ? toRoomKey(normalizedPlatform, normalizedRemoteRoomId)
      : null;
  }
  const row = selectRegistryRow(sqlite, normalizedPlatform, normalizedRemoteRoomId);
  if (row) return row.room_key;
  return legacyRoomExists(sqlite, normalizedPlatform, normalizedRemoteRoomId)
    ? toRoomKey(normalizedPlatform, normalizedRemoteRoomId)
    : null;
}

export interface ResolvedRoomKey {
  roomKey: string;
  platform: string;
  remoteRoomId: string;
  legacyRoomId: string | null;
  created: boolean;
}

/**
 * Resolve the canonical key, registering the room when it is unknown.
 *
 * The registry write is idempotent: the `(platform, remote_room_id)` unique index
 * decides the winner, so concurrent callers always agree on one key. `legacyRoomId`
 * is only recorded for rooms that already exist in `chat_rooms`, which keeps the
 * partial unique index on `(platform, legacy_room_id)` meaningful.
 *
 * Returns the registered key, its remote id, the legacy id when one exists, and
 * whether this call is the one that registered the room.
 */
export function resolveOrCreateRoomKeySync(
  platform: string,
  remoteRoomId: string,
  options: { sqlite?: Database; now?: number } = {},
): ResolvedRoomKey {
  const sqlite = options.sqlite ?? defaultDatabase();
  const normalizedPlatform = trimValue(platform, 'platform');
  const normalizedRemoteRoomId = trimValue(remoteRoomId, 'remoteRoomId');
  const canonical = toRoomKey(normalizedPlatform, normalizedRemoteRoomId);
  const now = options.now ?? Date.now();

  if (!tableExists(sqlite, 'room_keys')) {
    return {
      roomKey: canonical,
      platform: normalizedPlatform,
      remoteRoomId: normalizedRemoteRoomId,
      legacyRoomId: legacyRoomExists(sqlite, normalizedPlatform, normalizedRemoteRoomId)
        ? normalizedRemoteRoomId
        : null,
      created: false,
    };
  }

  const existing = selectRegistryRow(sqlite, normalizedPlatform, normalizedRemoteRoomId);
  if (existing) {
    return {
      roomKey: existing.room_key,
      platform: existing.platform,
      remoteRoomId: existing.remote_room_id,
      legacyRoomId: existing.legacy_room_id,
      created: false,
    };
  }

  const legacyRoomId = legacyRoomExists(sqlite, normalizedPlatform, normalizedRemoteRoomId)
    ? normalizedRemoteRoomId
    : null;
  const inserted = withImmediateTransaction(sqlite, () => {
    sqlite
      .query<never, [string, string, string, string | null, number]>(
        `INSERT OR IGNORE INTO room_keys (room_key, platform, remote_room_id, legacy_room_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(canonical, normalizedPlatform, normalizedRemoteRoomId, legacyRoomId, now);
    return selectRegistryRow(sqlite, normalizedPlatform, normalizedRemoteRoomId);
  });
  if (!inserted) {
    throw new Error(`Failed to register room key for ${canonical}`);
  }
  return {
    roomKey: inserted.room_key,
    platform: inserted.platform,
    remoteRoomId: inserted.remote_room_id,
    legacyRoomId: inserted.legacy_room_id,
    created: true,
  };
}

/**
 * Object form of {@link resolveOrCreateRoomKeySync}; kept for callers that want the
 * remote room id alongside the key (the webhook lane's `resolveRemoteRoom`).
 */
export type RoomKeyResolution = ResolvedRoomKey;

/** Resolve the canonical key, registering the room when unknown. */
export async function resolveOrCreateRoomKey(
  platform: string,
  remoteRoomId: string,
  options: { sqlite?: Database; now?: number } = {},
): Promise<string> {
  return resolveOrCreateRoomKeySync(platform, remoteRoomId, options).roomKey;
}

/**
 * Assert that a stored room key really is the canonical key for this
 * platform/remote pair, and (when the registry is available) that the registry
 * agrees. Returns `true` when consistent, otherwise throws a `RoomKeyMismatchError`.
 */
export function assertRoomKeyMatches(
  platform: string,
  remoteRoomId: string,
  roomKey: string | null | undefined,
  options: { sqlite?: Database } = {},
): true {
  const normalizedPlatform = trimValue(platform, 'platform');
  const normalizedRemoteRoomId = trimValue(remoteRoomId, 'remoteRoomId');
  const expected = toRoomKey(normalizedPlatform, normalizedRemoteRoomId);
  const actual = typeof roomKey === 'string' ? roomKey.trim() : '';
  if (actual.length === 0) {
    throw new RoomKeyMismatchError(expected, null, 'room key is missing');
  }
  // The registry is consulted first: a key that disagrees with the registered
  // room is a real identity conflict and needs the more specific message.
  const sqlite = options.sqlite;
  if (sqlite && tableExists(sqlite, 'room_keys')) {
    const row = selectRegistryRow(sqlite, normalizedPlatform, normalizedRemoteRoomId);
    if (row && row.room_key !== actual) {
      throw new RoomKeyMismatchError(
        expected,
        actual,
        `room_keys holds ${row.room_key} for this platform and remote room id`,
      );
    }
  }
  if (actual !== expected) {
    throw new RoomKeyMismatchError(expected, actual, 'room key does not encode this platform and remote room id');
  }
  const parsed = parseRoomKey(actual);
  if (!parsed || parsed.platform !== normalizedPlatform || parsed.remoteRoomId !== normalizedRemoteRoomId) {
    throw new RoomKeyMismatchError(expected, actual, 'room key is not transparent');
  }
  return true;
}

export class RoomKeyMismatchError extends Error {
  readonly expected: string;
  readonly actual: string | null;
  override readonly name = 'RoomKeyMismatchError';

  constructor(expected: string, actual: string | null, reason: string) {
    super(`Room key mismatch: ${reason} (expected ${expected}, received ${actual ?? 'none'})`);
    this.expected = expected;
    this.actual = actual;
  }
}

const COVERAGE_TARGETS: Array<{ table: string; column: string; optional: boolean }> = [
  { table: 'chat_rooms', column: 'room_key', optional: false },
  { table: 'messages', column: 'room_key', optional: false },
  { table: 'reminders', column: 'room_key', optional: false },
  { table: 'notification_subscriptions', column: 'room_key', optional: false },
  { table: 'message_inbox', column: 'room_key', optional: false },
  { table: 'message_outbox', column: 'room_key', optional: false },
  { table: 'scheduled_deliveries', column: 'room_key', optional: false },
  { table: 'user_roles', column: 'scope_room_key', optional: true },
  { table: 'flow_sessions', column: 'room_key', optional: true },
];

function count(sqlite: Database, sql: string): number {
  return Number(sqlite.query<{ count: number }, []>(sql).get()?.count ?? 0);
}

/**
 * Registry and row-coverage counters. Read-only: this never writes.
 */
export function getRoomKeyStats(sqlite: Database = defaultDatabase()): RoomKeyStats {
  const hasRegistry = tableExists(sqlite, 'room_keys');
  const coverage = COVERAGE_TARGETS
    .filter(target => hasColumn(sqlite, target.table, target.column))
    .map(target => {
      const total = count(sqlite, `SELECT count(*) AS count FROM \`${target.table}\``);
      const withRoomKey = count(
        sqlite,
        `SELECT count(*) AS count FROM \`${target.table}\` WHERE \`${target.column}\` IS NOT NULL AND \`${target.column}\` <> ''`,
      );
      return {
        table: target.table,
        column: target.column,
        total,
        withRoomKey,
        withoutRoomKey: total - withRoomKey,
        optional: target.optional,
      };
    });

  const roomKeys = hasRegistry ? count(sqlite, 'SELECT count(*) AS count FROM room_keys') : 0;
  const withLegacyRoomId = hasRegistry
    ? count(sqlite, "SELECT count(*) AS count FROM room_keys WHERE legacy_room_id IS NOT NULL AND legacy_room_id <> ''")
    : 0;
  const chatRooms = tableExists(sqlite, 'chat_rooms')
    ? count(sqlite, 'SELECT count(*) AS count FROM chat_rooms')
    : 0;
  const unregisteredChatRooms = hasRegistry && hasColumn(sqlite, 'chat_rooms', 'room_key')
    ? count(
        sqlite,
        `SELECT count(*) AS count FROM chat_rooms r
         WHERE NOT EXISTS (SELECT 1 FROM room_keys k WHERE k.room_key = r.room_key)`,
      )
    : 0;
  const nonTransparentRoomKeys = hasRegistry
    ? count(
        sqlite,
        `SELECT count(*) AS count FROM room_keys
         WHERE room_key <> 'room:' || platform || ':' || remote_room_id`,
      )
    : 0;
  const derivedKeyCollisions = hasRegistry
    ? count(
        sqlite,
        `SELECT count(*) AS count FROM room_keys k
         WHERE EXISTS (
           SELECT 1 FROM room_keys o
           WHERE o.room_key = 'room:' || k.platform || ':' || k.remote_room_id
             AND o.room_key <> k.room_key
         )`,
      )
    : 0;
  const hasConflictTable = tableExists(sqlite, 'room_key_conflicts');
  const conflicts = hasConflictTable
    ? count(sqlite, 'SELECT count(*) AS count FROM room_key_conflicts')
    : 0;
  const unresolvedConflicts = hasConflictTable
    ? count(sqlite, 'SELECT count(*) AS count FROM room_key_conflicts WHERE resolved_at IS NULL')
    : 0;

  return {
    roomKeys,
    withLegacyRoomId,
    chatRooms,
    unregisteredChatRooms,
    nonTransparentRoomKeys,
    derivedKeyCollisions,
    conflicts,
    unresolvedConflicts,
    coverage,
    coverageIsComplete: coverage.every(entry => entry.optional || entry.withoutRoomKey === 0),
  };
}

/**
 * Re-derive the room identity audit that migration 0022 recorded and return the
 * findings as data. Read-only: nothing is written, so it is safe to run against a
 * live database.
 */
export function findRoomKeyCollisions(sqlite: Database = defaultDatabase()): RoomKeyCollision[] {
  const collisions: RoomKeyCollision[] = [];
  const hasRegistry = tableExists(sqlite, 'room_keys');
  const hasConflictTable = tableExists(sqlite, 'room_key_conflicts');
  const hasChatRooms = tableExists(sqlite, 'chat_rooms');
  const chatRoomsHaveRoomKey = hasChatRooms && hasColumn(sqlite, 'chat_rooms', 'room_key');

  if (chatRoomsHaveRoomKey) {
    const opaqueRooms = sqlite
      .query<{ id: string; platform: string; room_key: string | null }, []>(
        `SELECT r.id, r.platform, r.room_key
         FROM chat_rooms r
         WHERE r.room_key IS NOT NULL AND r.room_key <> ''
           AND r.room_key <> r.id
           AND r.room_key <> 'room:' || COALESCE(r.platform, '') || ':' || r.id
         ORDER BY r.platform, r.id`,
      )
      .all();
    for (const row of opaqueRooms) {
      collisions.push({
        kind: 'chat_room_key_not_transparent',
        detail: 'chat_rooms.room_key is neither the canonical derived key nor the room id',
        table: 'chat_rooms',
        rowId: row.id,
        platform: row.platform,
        roomKey: row.room_key,
        remoteRoomId: row.id,
        legacyRoomId: row.id,
      });
    }
  }

  if (hasRegistry && chatRoomsHaveRoomKey) {
    const rows = sqlite
      .query<{ id: string; platform: string; room_key: string | null }, []>(
        `SELECT r.id, r.platform, r.room_key
         FROM chat_rooms r
         WHERE r.id IS NOT NULL AND r.id <> '' AND r.platform IS NOT NULL AND r.platform <> ''
           AND NOT EXISTS (
             SELECT 1 FROM room_keys k WHERE k.room_key = r.room_key
           )
         ORDER BY r.platform, r.id`,
      )
      .all();
    for (const row of rows) {
      collisions.push({
        kind: 'unregistered_chat_room',
        detail: 'chat_rooms row is not backed by a room_keys registry row',
        table: 'chat_rooms',
        rowId: row.id,
        platform: row.platform,
        roomKey: row.room_key,
        remoteRoomId: row.id,
        legacyRoomId: row.id,
      });
    }
  }

  if (hasRegistry) {
    const nonTransparent = sqlite
      .query<{ room_key: string; platform: string; remote_room_id: string; legacy_room_id: string | null }, []>(
        `SELECT room_key, platform, remote_room_id, legacy_room_id
         FROM room_keys
         WHERE room_key <> 'room:' || platform || ':' || remote_room_id
         ORDER BY room_key`,
      )
      .all();
    for (const row of nonTransparent) {
      collisions.push({
        kind: 'room_key_not_transparent',
        detail: 'room_keys.room_key does not encode its own platform/remote pair',
        table: 'room_keys',
        rowId: row.room_key,
        platform: row.platform,
        roomKey: row.room_key,
        remoteRoomId: row.remote_room_id,
        legacyRoomId: row.legacy_room_id,
      });
    }

    const taken = sqlite
      .query<{ room_key: string; platform: string; remote_room_id: string; legacy_room_id: string | null }, []>(
        `SELECT k.room_key, k.platform, k.remote_room_id, k.legacy_room_id
         FROM room_keys k
         WHERE EXISTS (
           SELECT 1 FROM room_keys o
           WHERE o.room_key = 'room:' || k.platform || ':' || k.remote_room_id
             AND o.room_key <> k.room_key
         )
         ORDER BY k.room_key`,
      )
      .all();
    for (const row of taken) {
      collisions.push({
        kind: 'room_key_taken',
        detail: `the canonical key for this platform/remote pair is stored as ${row.room_key}`,
        table: 'room_keys',
        rowId: row.room_key,
        platform: row.platform,
        roomKey: row.room_key,
        remoteRoomId: row.remote_room_id,
        legacyRoomId: row.legacy_room_id,
      });
    }
  }

  for (const target of [
    { table: 'messages', column: 'room_key' },
    { table: 'reminders', column: 'room_key' },
    { table: 'notification_subscriptions', column: 'room_key' },
  ]) {
    if (!chatRoomsHaveRoomKey || !hasColumn(sqlite, target.table, target.column)) continue;
    const rows = sqlite
      .query<{ id: string | number; room_key: string; chat_room_id: string; platform: string | null }, []>(
        `SELECT t.id, t.room_key, t.chat_room_id, t.platform
         FROM \`${target.table}\` t
         WHERE t.room_key IS NOT NULL AND t.room_key <> ''
           AND EXISTS (
             SELECT 1 FROM chat_rooms r
             WHERE r.id = t.chat_room_id AND r.room_key IS NOT NULL AND r.room_key <> ''
               AND r.room_key <> t.room_key
           )
         ORDER BY t.id`,
      )
      .all();
    for (const row of rows) {
      collisions.push({
        kind: 'room_key_mismatch',
        detail: `${target.table}.${target.column} differs from chat_rooms.room_key for the same room`,
        table: target.table,
        rowId: String(row.id),
        platform: row.platform,
        roomKey: row.room_key,
        remoteRoomId: row.chat_room_id,
        legacyRoomId: row.chat_room_id,
      });
    }
  }

  if (hasRegistry && hasColumn(sqlite, 'user_roles', 'scope_room_key')) {
    const rows = sqlite
      .query<{ platform: string; scope: string }, []>(
        `SELECT DISTINCT u.platform, u.scope
         FROM user_roles u
         WHERE u.scope IS NOT NULL AND u.scope <> '' AND lower(trim(u.scope)) <> 'global'
           AND (u.scope_room_key IS NULL OR u.scope_room_key = '')
           AND NOT EXISTS (
             SELECT 1 FROM room_keys k
             WHERE k.platform = u.platform AND (k.remote_room_id = u.scope OR k.legacy_room_id = u.scope)
           )
         ORDER BY u.platform, u.scope`,
      )
      .all();
    for (const row of rows) {
      collisions.push({
        kind: 'unresolved_scope',
        detail: 'user_roles scope is room scoped but does not resolve to a registered room',
        table: 'user_roles',
        rowId: null,
        platform: row.platform,
        roomKey: null,
        remoteRoomId: row.scope,
        legacyRoomId: row.scope,
      });
    }
  }

  if (hasConflictTable) {
    const recorded = sqlite
      .query<{ conflict_type: string; platform: string; room_key: string | null; remote_room_id: string | null; legacy_room_id: string | null; details: string | null }, []>(
        `SELECT conflict_type, platform, room_key, remote_room_id, legacy_room_id, details
         FROM room_key_conflicts
         ORDER BY conflict_type, platform, COALESCE(remote_room_id, ''), COALESCE(room_key, '')`,
      )
      .all();
    for (const row of recorded) {
      collisions.push({
        kind: `recorded:${row.conflict_type}`,
        detail: row.details ?? 'recorded by a previous audit',
        table: 'room_key_conflicts',
        rowId: null,
        platform: row.platform,
        roomKey: row.room_key,
        remoteRoomId: row.remote_room_id,
        legacyRoomId: row.legacy_room_id,
      });
    }
  }

  return collisions;
}
