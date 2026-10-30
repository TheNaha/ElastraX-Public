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
 *  - Migration 0022 adds a canonical `room_key` column to every durable room
 *    table; `chat_rooms.id` now holds the canonical room key on insert, while
 *    the legacy `chat_room_id` columns are retained as inert data only.
 *  - Every durable room read/writes `room_key` only; there is no legacy
 *    `chat_room_id` fallback.
 *  - Provider sends always receive the raw provider chat id, never a room key.
 *
 * The canonical form is produced here rather than imported from `src/db/rooms`
 * (the database lane owns that module) because this module sits on the hot path
 * of every tool and must not pull the database handle into their module graph —
 * test files that inject a partial `../src/db` double would otherwise break.
 * `test/roomKey.test.ts` pins this implementation against
 * `toRoomKey()` from `src/db/rooms`, so the two can never drift silently.
 */

import { eq, type Column, type SQL } from 'drizzle-orm';
import { chatRooms, messages, notificationSubscriptions, reminders } from '../db/schema';
import type { MessageContext } from '../core/MessageContext';
import {
  ROOM_KEY_PREFIX,
  ROOM_KEY_SEPARATOR,
  isRoomKeyFor as isRoomKeyForFormat,
  normalizeRoomId as normalizeRoomIdFormat,
  parseRoomReference,
  roomIdFromRoomKey as roomIdFromRoomKeyFormat,
  toRoomKey as toRoomKeyFormat,
} from '../core/roomKeyFormat';

export { ROOM_KEY_SEPARATOR, ROOM_KEY_PREFIX };
/** The drizzle symbol that holds a table's column map. */

/** A `room_key` column (or any column usable inside `eq`). */
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
 *
 * The format itself is owned by `src/core/roomKeyFormat.ts`; this module only
 * re-exports it so the tool layer keeps a single import site.
 */
export function toRoomKey(platform: string, chatId: string): string {
  return toRoomKeyFormat(platform, chatId);
}

/**
 * Parse a stored room reference. Accepts the canonical `room:<platform>:<id>`
 * form and the pre-migration `<platform>:<id>` form; a raw provider chat id
 * (WhatsApp JID, Discord channel id) contains no platform segment and therefore
 * does not parse as a key.
 */
export function parseRoomKey(value: string | null | undefined): ParsedRoomKey | null {
  return parseRoomReference(value);
}

/** True when `value` is a room key that belongs to `platform`. */
export function isRoomKeyFor(value: string | null | undefined, platform: string): boolean {
  return isRoomKeyForFormat(value, platform);
}

/**
 * Strip the platform segment from a stored room key.
 * Returns `null` when the value is not a key, or is a key owned by a different
 * platform — such a value must never be handed to a provider.
 */
export function roomIdFromRoomKey(value: string | null | undefined, platform: string): string | null {
  return roomIdFromRoomKeyFormat(value, platform);
}

/**
 * Accept either a raw provider chat id or a canonical key and return the raw
 * provider chat id. Role/scope paths that accept a room reference use this so a
 * key and an id never end up stored under two different owners. A key belonging
 * to another platform is returned untouched and must fail authorization later.
 */
export function normalizeRoomId(platform: string, room: string): string {
  return normalizeRoomIdFormat(platform, room);
}

/** Canonical room key for a context: `ctx.roomKey ?? toRoomKey(platform, chatId)`. */
export function getCanonicalRoomKey(ctx: RoomKeyContext): string {
  const explicit = typeof ctx.roomKey === 'string' ? ctx.roomKey.trim() : '';
  if (explicit.length > 0) {
    const parsed = parseRoomReference(explicit);
    if (parsed && parsed.platform === ctx.platform) return explicit;
  }
  return toRoomKey(ctx.platform, ctx.chatId);
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

// ── Schema (post migration 0022) ──────────────────────────────────────────────
//
// Migration 0022 adds a canonical `room_key` column to every durable room table.
// Every read and write here targets `room_key` only; the legacy `chat_room_id`
// columns are retained as inert data and are no longer queried for room identity.

/** Columns that identify a room in one table. */
export interface RoomColumns {
  /** Legacy room column holding the raw provider chat id. Retained as inert data. */
  legacy: Column;
  /** Canonical `room_key` column. Always present after migration 0022. */
  canonical: Column;
  /** Platform column used to scope platform-scoped lookups. */
  platform: Column;
}

export function chatRoomsRoomColumns(_table?: unknown): RoomColumns {
  return {
    legacy: chatRooms.id,
    canonical: chatRooms.roomKey,
    platform: chatRooms.platform,
  };
}

export function messagesRoomColumns(_table?: unknown): RoomColumns {
  return {
    legacy: messages.chatRoomId,
    canonical: messages.roomKey,
    platform: messages.platform,
  };
}

/** Canonical `reminders.room_key` column. Always present after migration 0022. */
export function remindersRoomColumns(_table?: unknown): RoomColumns {
  return {
    legacy: reminders.chatRoomId,
    canonical: reminders.roomKey,
    platform: reminders.platform,
  };
}

export function subscriptionRoomColumns(_table?: unknown): RoomColumns {
  return {
    legacy: notificationSubscriptions.chatRoomId,
    canonical: notificationSubscriptions.roomKey,
    platform: notificationSubscriptions.platform,
  };
}

// ── Query building ────────────────────────────────────────────────────────────

/**
 * Condition matching every row of `columns` that belongs to `identity`:
 * the canonical `roomKey` only.
 */
export function roomIdentityCondition(columns: RoomColumns, identity: RoomIdentity): SQL {
  return eq(columns.canonical, identity.roomKey);
}

/** Pick the row that matches the canonical key. */
export function pickPreferredRoomRow<T extends { roomKey?: string | null }>(rows: T[], roomKey: string): T | undefined {
  return rows.find(row => row.roomKey === roomKey);
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** Insert payload fragment that writes the canonical room key. */
export function chatRoomKeyInsertValues(roomKey: string): Partial<typeof chatRooms.$inferInsert> {
  return { roomKey } as Partial<typeof chatRooms.$inferInsert>;
}

export function messageRoomKeyInsertValues(roomKey: string): Partial<typeof messages.$inferInsert> {
  return { roomKey } as Partial<typeof messages.$inferInsert>;
}

export function subscriptionRoomKeyInsertValues(roomKey: string): Partial<typeof notificationSubscriptions.$inferInsert> {
  return { roomKey } as Partial<typeof notificationSubscriptions.$inferInsert>;
}

/** Update/insert fragment that writes the canonical room key. */
export function roomKeyWriteValues(roomKey: string): { roomKey?: string } {
  return { roomKey };
}

/** Backfill fragment for an update on an existing row whose `room_key` is still empty. */
export function roomKeyBackfill(storedRoomKey: string | null | undefined, roomKey: string): { roomKey?: string } {
  const stored = typeof storedRoomKey === 'string' ? storedRoomKey.trim() : '';
  if (stored.length > 0) return {};
  return { roomKey };
}
