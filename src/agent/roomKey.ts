/**
 * @file src/agent/roomKey.ts
 * @description Canonical room identity helpers shared by the agent, its tools, and
 * the notification plumbing.
 *
 * A room is identified by the tuple `(platform, provider chat id)`. ElastraX used
 * to key rooms by the provider chat id alone, which is only unique *within* a
 * platform — the same id can exist on WhatsApp and Discord simultaneously. The
 * canonical room key is the deterministic, transparent string
 * `"room:<platform>:<chatId>"` documented by `src/db/schema.ts` (migration 0022),
 * so any stored key can be parsed back without a registry lookup.
 *
 * Migration contract (the database lane owns `src/db`):
 *  - `chat_rooms.id`, `messages.chat_room_id` and
 *    `notification_subscriptions.chat_room_id` keep holding the **raw provider
 *    chat id**, so existing rows, foreign keys and provider sends keep working.
 *  - When the schema exposes a `roomKey` column it is dual-written on insert and
 *    preferred on read; the legacy column is retained as a migration fallback.
 *  - Rows created before the migration are still reachable through the legacy
 *    fallback, always scoped by platform so a cross-platform id collision can
 *    never leak one platform's rows into another's.
 *  - Provider sends always receive the raw provider chat id, never a room key.
 *
 * The canonical form is produced here rather than imported from `src/db/rooms`
 * (the database lane owns that module) because this module sits on the hot path
 * of every tool and must not pull the database handle into their module graph —
 * test files that inject a partial `../src/db` double would otherwise break.
 * `test/roomKey.test.ts` pins this implementation against
 * `toRoomKey()` from `src/db/rooms`, so the two can never drift silently.
 *
 * Every helper degrades to the pre-migration behaviour when no `roomKey` column
 * exists, so this module is safe to use against a database that has not been
 * migrated yet.
 */

import { and, eq, isNull, or, type Column, type SQL } from 'drizzle-orm';
import { chatRooms, messages, notificationSubscriptions, reminders } from '../db/schema';
import type { MessageContext } from '../core/MessageContext';

export const ROOM_KEY_SEPARATOR = ':';
/** Every canonical room key starts with this marker, so keys are self-describing. */
export const ROOM_KEY_PREFIX = 'room';
/** The drizzle symbol that holds a table's column map. */
const DRIZZLE_COLUMNS = Symbol.for('drizzle:Columns');

/** A `room_key` column (or any column usable inside `eq`/`and`/`or`). */
export type RoomKeyColumn = Column;

/** Minimal context surface required to derive a room identity. */
export type RoomKeyContext = Pick<MessageContext, 'platform' | 'chatId' | 'roomKey'>;

export interface RoomIdentity {
  platform: string;
  /** Canonical `"room:<platform>:<chatId>"` key. */
  roomKey: string;
  /** Raw provider chat id — the only value providers accept as a send target. */
  roomId: string;
}

export interface ParsedRoomKey {
  platform: string;
  remoteRoomId: string;
}

// ── Key derivation ───────────────────────────────────────────────────────────

/**
 * Canonical room key for a provider chat id: `room:<platform>:<chatId>`.
 * Identical to `toRoomKey()` from `src/db/rooms` — see the module header.
 */
export function toRoomKey(platform: string, chatId: string): string {
  return `${ROOM_KEY_PREFIX}${ROOM_KEY_SEPARATOR}${platform}${ROOM_KEY_SEPARATOR}${chatId}`;
}

/**
 * Parse a stored room reference. Accepts the canonical `room:<platform>:<id>`
 * form and the pre-migration `<platform>:<id>` form; a raw provider chat id
 * (WhatsApp JID, Discord channel id) contains no platform segment and therefore
 * does not parse as a key.
 */
export function parseRoomKey(value: string | null | undefined): ParsedRoomKey | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw.length === 0) return null;
  const body = raw.startsWith(`${ROOM_KEY_PREFIX}${ROOM_KEY_SEPARATOR}`)
    ? raw.slice(ROOM_KEY_PREFIX.length + 1)
    : raw;
  const separator = body.indexOf(ROOM_KEY_SEPARATOR);
  if (separator <= 0) return null;
  const platform = body.slice(0, separator);
  const remoteRoomId = body.slice(separator + 1);
  if (platform.length === 0 || remoteRoomId.length === 0) return null;
  return { platform, remoteRoomId };
}

/** True when `value` is a room key that belongs to `platform`. */
export function isRoomKeyFor(value: string | null | undefined, platform: string): boolean {
  const parsed = parseRoomKey(value);
  return parsed !== null && parsed.platform === platform;
}

/**
 * Strip the platform segment from a stored room key.
 * Returns `null` when the value is not a key, or is a key owned by a different
 * platform — such a value must never be handed to a provider.
 */
export function roomIdFromRoomKey(value: string | null | undefined, platform: string): string | null {
  const parsed = parseRoomKey(value);
  if (parsed === null || parsed.platform !== platform) return null;
  return parsed.remoteRoomId;
}

/**
 * Accept either a raw provider chat id or a canonical key and return the raw
 * provider chat id. Role/scope paths that accept a room reference use this so a
 * key and an id never end up stored under two different owners. A key belonging
 * to another platform is returned untouched and must fail authorization later.
 */
export function normalizeRoomId(platform: string, room: string): string {
  if (typeof room !== 'string') return room;
  const parsed = parseRoomKey(room);
  if (parsed === null || parsed.platform !== platform) return room;
  return parsed.remoteRoomId;
}

/** Canonical room key for a context: `ctx.roomKey ?? toRoomKey(platform, chatId)`. */
export function getCanonicalRoomKey(ctx: RoomKeyContext): string {
  const explicit = typeof ctx.roomKey === 'string' ? ctx.roomKey.trim() : '';
  return explicit.length > 0 ? explicit : toRoomKey(ctx.platform, ctx.chatId);
}

/** Canonical key plus the raw provider chat id it was derived from. */
export function resolveRoomIdentity(ctx: RoomKeyContext): RoomIdentity {
  return { platform: ctx.platform, roomKey: getCanonicalRoomKey(ctx), roomId: ctx.chatId };
}

/** True when two room references (keys and/or raw ids) denote the same room. */
export function isSameRoom(
  platform: string,
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left === right) return true;
  const leftKey = isRoomKeyFor(left, platform) ? left : toRoomKey(platform, left);
  const rightKey = isRoomKeyFor(right, platform) ? right : toRoomKey(platform, right);
  return leftKey === rightKey;
}

/**
 * Resolve the raw provider chat id a stored room row should be delivered to.
 * `chat_rooms.id` holds the raw chat id, but a stored `room_key` is preferred
 * and unwrapped so a key can never reach a provider.
 */
export function roomRemoteId(
  row: { id?: string | null; roomKey?: string | null } | null | undefined,
  platform: string,
): string {
  for (const candidate of [row?.roomKey, row?.id]) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const remoteId = roomIdFromRoomKey(candidate, platform);
    if (remoteId !== null) return remoteId;
  }
  return typeof row?.id === 'string' ? row.id : '';
}

// ── Schema compatibility ──────────────────────────────────────────────────────

/**
 * Detect a `roomKey` column on a drizzle table.
 * Returns `null` for tables that do not expose one yet (or for test doubles),
 * which is what keeps the legacy single-column behaviour intact.
 */
export function detectRoomKeyColumn(table: unknown): RoomKeyColumn | null {
  const columns = (table as Record<symbol, Record<string, unknown> | undefined> | null | undefined)?.[
    DRIZZLE_COLUMNS
  ];
  const column = columns?.['roomKey'];
  return column ? (column as RoomKeyColumn) : null;
}

export interface RoomKeyColumnSet {
  chatRooms: RoomKeyColumn | null;
  messages: RoomKeyColumn | null;
  reminders: RoomKeyColumn | null;
  notificationSubscriptions: RoomKeyColumn | null;
}

const detectedRoomKeyColumns: RoomKeyColumnSet = {
  chatRooms: detectRoomKeyColumn(chatRooms),
  messages: detectRoomKeyColumn(messages),
  reminders: detectRoomKeyColumn(reminders),
  notificationSubscriptions: detectRoomKeyColumn(notificationSubscriptions),
};

let activeRoomKeyColumns: RoomKeyColumnSet = { ...detectedRoomKeyColumns };

/**
 * Test seam that lets a suite exercise the post-migration query/insert shape
 * against the pre-migration schema (and vice versa) without touching `src/db`.
 * Pass `null` to restore detection from the real schema.
 */
export function setRoomKeyColumnsForTesting(next: Partial<RoomKeyColumnSet> | null): void {
  activeRoomKeyColumns = next ? { ...activeRoomKeyColumns, ...next } : { ...detectedRoomKeyColumns };
}

/**
 * Canonical column for a table.
 *
 * An explicitly supplied table is authoritative: it is what a caller injected,
 * and referencing a column that table does not have would build invalid SQL.
 * Without a table the active column set is used, which is what the agent and its
 * tools read (and what {@link setRoomKeyColumnsForTesting} overrides).
 */
export function hasCanonicalRoomKeyColumns(): boolean {
  return activeRoomKeyColumns.chatRooms !== null;
}

export function resolveRoomKeyColumn(
  target: keyof RoomKeyColumnSet,
  table?: unknown,
): RoomKeyColumn | null {
  if (table !== undefined) return detectRoomKeyColumn(table);
  return activeRoomKeyColumns[target];
}

/** Columns that identify a room in one table. */
export interface RoomColumns {
  /** Legacy room column holding the raw provider chat id. */
  legacy: Column;
  /** Canonical `roomKey` column, or `null` while the schema lacks it. */
  canonical: Column | null;
  /**
   * Platform column used to keep the legacy fallback collision-free. Nullable
   * rows (pre-migration `messages.platform`) are matched as well.
   */
  platform?: Column | null;
}

export function chatRoomsRoomColumns(table?: unknown): RoomColumns {
  return {
    legacy: chatRooms.id,
    canonical: resolveRoomKeyColumn('chatRooms', table),
    platform: chatRooms.platform,
  };
}

export function messagesRoomColumns(table?: unknown): RoomColumns {
  return {
    legacy: messages.chatRoomId,
    canonical: resolveRoomKeyColumn('messages', table),
    platform: messages.platform,
  };
}

/** Canonical `reminders.room_key` column, or `null` before the migration. */
export function remindersRoomColumns(table?: unknown): RoomColumns {
  return {
    legacy: reminders.chatRoomId,
    canonical: resolveRoomKeyColumn('reminders', table),
    platform: reminders.platform,
  };
}

export function remindersRoomKeyColumn(): RoomKeyColumn | null {
  return activeRoomKeyColumns.reminders;
}

export function subscriptionRoomColumns(table?: unknown): RoomColumns {
  return {
    legacy: notificationSubscriptions.chatRoomId,
    canonical: resolveRoomKeyColumn('notificationSubscriptions', table),
    platform: notificationSubscriptions.platform,
  };
}

// ── Query building ────────────────────────────────────────────────────────────

function legacyRoomCondition(columns: RoomColumns, identity: RoomIdentity): SQL {
  // A pre-migration row stores the raw chat id; a post-migration row may store
  // either the raw chat id or the canonical key in the same column.
  const values = identity.roomId === identity.roomKey ? [identity.roomId] : [identity.roomId, identity.roomKey];
  const terms = values.map(value => {
    const idTerm = eq(columns.legacy, value);
    if (!columns.platform) return idTerm;
    return or(and(eq(columns.platform, identity.platform), idTerm), and(isNull(columns.platform), idTerm))!;
  });
  return terms.length === 1 ? terms[0]! : or(...terms)!;
}

/**
 * Condition matching every row of `columns` that belongs to `identity`:
 * the canonical `roomKey` when the schema exposes it, plus the legacy
 * raw-chat-id column as a migration fallback (platform-scoped).
 */
export function roomIdentityCondition(columns: RoomColumns, identity: RoomIdentity): SQL {
  const legacy = legacyRoomCondition(columns, identity);
  if (!columns.canonical) return legacy;
  return or(eq(columns.canonical, identity.roomKey), legacy)!;
}

/** Pick the row that matches the canonical key, falling back to the first match. */
export function pickPreferredRoomRow<T extends { roomKey?: string | null }>(rows: T[], roomKey: string): T | undefined {
  return rows.find(row => row.roomKey === roomKey) ?? rows[0];
}

// ── Dual writes ───────────────────────────────────────────────────────────────

/**
 * Insert payload fragment that dual-writes the canonical room key.
 * Empty while the target table has no `roomKey` column.
 */
export function chatRoomKeyInsertValues(roomKey: string): Partial<typeof chatRooms.$inferInsert> {
  return activeRoomKeyColumns.chatRooms
    ? ({ roomKey } as Partial<typeof chatRooms.$inferInsert>)
    : {};
}

export function messageRoomKeyInsertValues(roomKey: string): Partial<typeof messages.$inferInsert> {
  return activeRoomKeyColumns.messages
    ? ({ roomKey } as Partial<typeof messages.$inferInsert>)
    : {};
}

export function subscriptionRoomKeyInsertValues(
  canonical: RoomKeyColumn | null,
  roomKey: string,
): Partial<typeof notificationSubscriptions.$inferInsert> {
  return canonical ? ({ roomKey } as Partial<typeof notificationSubscriptions.$inferInsert>) : {};
}

/**
 * Update/insert fragment that writes the canonical room key.
 * Empty when the target table has no `roomKey` column.
 */
export function roomKeyWriteValues(canonical: RoomKeyColumn | null, roomKey: string): { roomKey?: string } {
  return canonical ? { roomKey } : {};
}

/**
 * Backfill fragment for an update on an existing row whose `roomKey` is still
 * empty. Returns an empty fragment when the schema has no `roomKey` column or
 * the row already carries the canonical key.
 */
export function roomKeyBackfill(
  canonical: RoomKeyColumn | null,
  storedRoomKey: string | null | undefined,
  roomKey: string,
): { roomKey?: string } {
  if (!canonical) return {};
  const stored = typeof storedRoomKey === 'string' ? storedRoomKey.trim() : '';
  if (stored.length > 0) return {};
  return { roomKey };
}
