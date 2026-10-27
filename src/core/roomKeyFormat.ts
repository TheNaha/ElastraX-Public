/**
 * @file src/core/roomKeyFormat.ts
 * @description The canonical room-key format, in one place.
 *
 * A room key is the platform-scoped identity of a room:
 *
 *   `room:<platform>:<remoteRoomId>`
 *
 * e.g. `room:whatsapp:6281234567890@s.whatsapp.net`.
 *
 * The *format* used to be written out in seven places — `src/db/rooms.ts`,
 * `src/agent/roomKey.ts`, `src/messaging/roomKeys.ts`, `src/utils/AuthService.ts`,
 * `src/utils/IdentityService.ts`, `src/core/FlowHandler.ts` and
 * `src/tools/RoleTool.ts` — and five of them did not trim or validate their
 * inputs, so a key built by one subsystem could disagree with a key built by
 * another for the same room. This module is the only place the format is
 * defined; every producer calls `toRoomKey()`.
 *
 * It deliberately has **no imports**. `src/agent/roomKey.ts` must not pull the
 * database handle into the module graph of every tool (test files that inject a
 * partial `../src/db` double would break), and a leaf module satisfies that
 * without duplicating the format.
 */

/** Separator between the key's segments. */
export const ROOM_KEY_SEPARATOR = ':';
/** First segment of every canonical key, so a key is self-describing. */
export const ROOM_KEY_PREFIX = 'room';
/** Prefix including its separator, e.g. `room:`. */
export const ROOM_KEY_FULL_PREFIX = `${ROOM_KEY_PREFIX}${ROOM_KEY_SEPARATOR}`;

export interface RoomKeyParts {
  platform: string;
  remoteRoomId: string;
}

/**
 * Build the canonical key for a platform/remote-id pair.
 *
 * Pure and deterministic: no database access, no validation, no throwing. The
 * database lane adds its own validation (see `src/db/rooms.ts`) on top of this
 * format; the format itself is defined here and nowhere else.
 */
export function toRoomKey(platform: string, remoteRoomId: string): string {
  const normalizedPlatform = typeof platform === 'string' ? platform.trim() : '';
  const normalizedRemoteRoomId = typeof remoteRoomId === 'string' ? remoteRoomId.trim() : '';
  return `${ROOM_KEY_FULL_PREFIX}${normalizedPlatform}${ROOM_KEY_SEPARATOR}${normalizedRemoteRoomId}`;
}

/**
 * Parse a canonical `room:<platform>:<id>` key.
 *
 * Strict: the `room:` prefix is required. A raw provider chat id contains no
 * platform segment and therefore does not parse as a key, and neither does the
 * pre-migration `<platform>:<id>` form (which no producer writes).
 */
export function parseCanonicalRoomKey(value: string | null | undefined): RoomKeyParts | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw.startsWith(ROOM_KEY_FULL_PREFIX)) return null;
  const body = raw.slice(ROOM_KEY_FULL_PREFIX.length);
  const separator = body.indexOf(ROOM_KEY_SEPARATOR);
  if (separator <= 0) return null;
  const platform = body.slice(0, separator);
  const remoteRoomId = body.slice(separator + 1);
  if (platform.length === 0 || remoteRoomId.length === 0) return null;
  return { platform, remoteRoomId };
}

/**
 * Parse a stored room *reference*, which may be either the canonical
 * `room:<platform>:<id>` form or the pre-migration `<platform>:<id>` form.
 *
 * This is the parser every subsystem must use when it is interpreting a value
 * that came out of the database, so that one stored value can never mean two
 * different things in two different subsystems.
 */
export function parseRoomReference(value: string | null | undefined): RoomKeyParts | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw.length === 0) return null;
  const body = raw.startsWith(ROOM_KEY_FULL_PREFIX)
    ? raw.slice(ROOM_KEY_FULL_PREFIX.length)
    : raw;
  const separator = body.indexOf(ROOM_KEY_SEPARATOR);
  if (separator <= 0) return null;
  const platform = body.slice(0, separator);
  const remoteRoomId = body.slice(separator + 1);
  if (platform.length === 0 || remoteRoomId.length === 0) return null;
  return { platform, remoteRoomId };
}

/**
 * True when `value` is a canonical room key that belongs to `platform`.
 *
 * The canonical form is required. The permissive `<platform>:<id>` form is
 * deliberately *not* accepted here: this predicate decides whether a value is
 * already a key or has to be converted into one, and accepting the legacy form
 * meant a user-supplied scope such as `whatsapp:abc` was stored verbatim as a
 * room key — a non-canonical value in a column that the database lane's own
 * `isCanonicalRoomKey` would reject.
 */
export function isRoomKeyFor(value: string | null | undefined, platform: string): boolean {
  const parsed = parseCanonicalRoomKey(value);
  return parsed !== null && parsed.platform === platform;
}

/**
 * Strip the platform segment from a stored room reference.
 *
 * Returns `null` when the value is not a reference, or is a key owned by a
 * different platform — such a value must never be handed to a provider.
 */
export function roomIdFromRoomKey(value: string | null | undefined, platform: string): string | null {
  const parsed = parseRoomReference(value);
  if (parsed === null || parsed.platform !== platform) return null;
  return parsed.remoteRoomId;
}

/**
 * Accept either a raw provider chat id or a canonical key and return the raw
 * provider chat id. A key belonging to another platform is returned untouched
 * so authorization can reject it.
 */
export function normalizeRoomId(platform: string, room: string): string {
  if (typeof room !== 'string') return room;
  const parsed = parseRoomReference(room);
  if (parsed === null || parsed.platform !== platform) return room;
  return parsed.remoteRoomId;
}
