/**
 * @file src/messaging/roomKeys.ts
 * @description Runtime/room-identity facade used by the messaging, webhook,
 *              digest and scheduler lanes.
 *
 * A room key is the canonical, platform-scoped identity of a room:
 * `room:<platform>:<remoteRoomId>`.  Every durable row is filed under that key
 * while provider I/O keeps using the raw remote room id (WhatsApp JID / Discord
 * channel id), and the legacy `chat_room_id` columns are always retained so any
 * row can still be rolled back onto the pre-0022 layout.
 *
 * Nothing here throws: when the room registry is unavailable (unmigrated
 * database, closed handle, injected test double) the deterministic derived key
 * is used, so message handling and delivery keep working.
 */

import {
  parseRoomKey,
  resolveOrCreateRoomKey,
  resolveOrCreateRoomKeySync,
  resolveRoomKeySync,
  toRoomKey,
  type ResolvedRoomKey,
} from '../db/rooms';
import { sqlite } from '../db';
import { logger } from '../utils/logger';

export const ROOM_PLATFORMS = ['whatsapp', 'discord'] as const;
export type RoomPlatform = (typeof ROOM_PLATFORMS)[number];
export const DEFAULT_ROOM_PLATFORM: RoomPlatform = 'whatsapp';

const ROOM_KEY_COLUMN = 'room_key';
const COLUMN_CACHE_TTL_MS = 30_000;

type SqliteLike = {
  query(sql: string, ...params: unknown[]): {
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
};

const columnPresence = new WeakMap<SqliteLike, Map<string, { at: number; present: boolean }>>();

/** The live SQLite handle, or `null` when the database is not reachable. */
function databaseHandle(): SqliteLike | null {
  try {
    const candidate = sqlite as unknown as { query?: unknown };
    return typeof candidate.query === 'function' ? (candidate as SqliteLike) : null;
  } catch {
    return null;
  }
}

function stringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : null;
}

function asResolution(value: unknown): ResolvedRoomKey | null {
  if (typeof value === 'string') {
    const roomKey = value.trim();
    const parts = parseRoomKey(roomKey);
    if (!roomKey || !parts) return null;
    return {
      roomKey,
      platform: parts.platform,
      remoteRoomId: parts.remoteRoomId,
      legacyRoomId: null,
      created: false,
    };
  }
  const roomKey = stringField(value, 'roomKey') ?? stringField(value, 'key') ?? stringField(value, 'id');
  if (!roomKey) return null;
  const parts = parseRoomKey(roomKey);
  return {
    roomKey,
    platform: stringField(value, 'platform') ?? parts?.platform ?? '',
    remoteRoomId: stringField(value, 'remoteRoomId') ?? stringField(value, 'chatRoomId') ?? parts?.remoteRoomId ?? '',
    legacyRoomId: stringField(value, 'legacyRoomId'),
    created: value !== null && typeof value === 'object' && (value as { created?: unknown }).created === true,
  };
}

export function isRoomPlatform(value: unknown): value is RoomPlatform {
  return typeof value === 'string' && (ROOM_PLATFORMS as readonly string[]).includes(value);
}

export function normalizeRoomPlatform(value: unknown): RoomPlatform | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return isRoomPlatform(normalized) ? normalized : null;
}

/** Best-effort platform guess from the shape of a raw provider room id. */
export function inferRoomPlatform(remoteRoomId: string): RoomPlatform | null {
  const value = remoteRoomId.trim();
  if (!value) return null;
  if (value.includes('@')) {
    return value.endsWith('@g.us') || value.includes('@s.whatsapp.net') ? 'whatsapp' : null;
  }
  return /^\d{5,32}$/.test(value) ? 'discord' : null;
}

/** The platform encoded in a canonical room key, if it names a known platform. */
export function platformPrefixOf(value: string): RoomPlatform | null {
  return normalizeRoomPlatform(parseRoomKey(value)?.platform);
}

/** The platform encoded in a canonical room key, without validating the name. */
export function keyPlatformOf(value: string): string | null {
  return parseRoomKey(value)?.platform ?? null;
}

/**
 * Interpret a stored room reference.
 *  - `key`     — a canonical room key (even for an unknown platform);
 *  - `raw`     — a bare provider room id (pre-key layout);
 *  - `empty`   — nothing usable.
 */
function storedRoomReference(
  storedRoomId: string,
): { kind: 'key'; platform: string; remoteRoomId: string } | { kind: 'raw' } | { kind: 'empty' } {
  const value = storedRoomId.trim();
  if (!value) return { kind: 'empty' };
  const parts = parseRoomKey(value);
  return parts ? { kind: 'key', platform: parts.platform, remoteRoomId: parts.remoteRoomId } : { kind: 'raw' };
}

/** Pure canonical key for a (platform, remote id) pair — never touches the DB. */
export function canonicalRoomKey(platform: string, remoteRoomId: string): string {
  const remote = remoteRoomId.trim();
  if (!remote) return '';
  try {
    return toRoomKey(platform, remote);
  } catch (error) {
    logger.warn({ err: error, platform, remoteRoomId: remote }, '[rooms] toRoomKey failed; using derived key');
    return `room:${platform}:${remote}`;
  }
}

/** The remote room id encoded in a canonical key, or `null` for other input. */
export function remoteRoomIdFromKey(value: string): string | null {
  return parseRoomKey(value)?.remoteRoomId ?? null;
}

/**
 * Resolve the canonical key for a room, registering it when unknown. Falls back
 * to the derived key if the registry cannot be reached.
 */
export function resolveRemoteRoom(
  platform: string,
  remoteRoomId: string,
): { roomKey: string; remoteRoomId: string; platform: string } {
  const remote = remoteRoomId.trim();
  const normalizedPlatform = normalizeRoomPlatform(platform) ?? platform.trim();
  if (!remote || !normalizedPlatform) {
    return { roomKey: '', remoteRoomId: remote, platform: normalizedPlatform };
  }
  const handle = databaseHandle();
  try {
    const resolution = resolveOrCreateRoomKeySync(
      normalizedPlatform,
      remote,
      handle ? { sqlite: handle as never } : {},
    );
    const resolved = asResolution(resolution);
    if (resolved) {
      return {
        roomKey: resolved.roomKey,
        remoteRoomId: resolved.remoteRoomId || remote,
        platform: resolved.platform || normalizedPlatform,
      };
    }
  } catch (error) {
    logger.warn({ err: error, platform: normalizedPlatform, remoteRoomId: remote }, '[rooms] room key resolution failed; using derived key');
  }
  return {
    roomKey: canonicalRoomKey(normalizedPlatform, remote),
    remoteRoomId: remote,
    platform: normalizedPlatform,
  };
}

/** Canonical key for a room, registering it when unknown. */
export function resolveCanonicalRoomKey(platform: string, remoteRoomId: string): string {
  return resolveRemoteRoom(platform, remoteRoomId).roomKey;
}

/**
 * Async form of {@link resolveCanonicalRoomKey}. Used by the webhook intake
 * path, which is already asynchronous.
 */
export async function resolveCanonicalRoomKeyAsync(
  platform: string,
  remoteRoomId: string,
): Promise<string> {
  const remote = remoteRoomId.trim();
  const normalizedPlatform = normalizeRoomPlatform(platform) ?? platform.trim();
  if (!remote || !normalizedPlatform) return '';
  const handle = databaseHandle();
  try {
    const resolved = await resolveOrCreateRoomKey(
      normalizedPlatform,
      remote,
      handle ? { sqlite: handle as never } : {},
    );
    return asResolution(resolved)?.roomKey ?? canonicalRoomKey(normalizedPlatform, remote);
  } catch (error) {
    logger.warn({ err: error, platform: normalizedPlatform, remoteRoomId: remote }, '[rooms] room key resolution failed; using derived key');
    return canonicalRoomKey(normalizedPlatform, remote);
  }
}

/** Canonical key for a context that may already carry one (production always does). */
export function roomKeyForContext(ctx: { platform: string; chatId: string; roomKey?: string | null }): string {
  const explicit = typeof ctx.roomKey === 'string' ? ctx.roomKey.trim() : '';
  if (explicit) return explicit;
  return resolveCanonicalRoomKey(ctx.platform, ctx.chatId);
}

/**
 * Extract the raw provider room id from a stored room reference.
 * Returns `null` when the reference is a canonical key of a different platform,
 * which must never be handed to a provider.
 */
export function remoteRoomIdFromRoomKey(platform: string, storedRoomId: string): string | null {
  const reference = storedRoomReference(storedRoomId);
  if (reference.kind === 'empty') return null;
  if (reference.kind === 'raw') return storedRoomId.trim();
  return reference.platform === platform ? reference.remoteRoomId : null;
}

/** Canonical key for a stored room reference, preferring an explicit key. */
export function canonicalRoomKeyForStoredRoom(platform: string, storedRoomId: string): string {
  const reference = storedRoomReference(storedRoomId);
  if (reference.kind === 'empty') return '';
  if (reference.kind === 'key') return storedRoomId.trim();
  return resolveCanonicalRoomKey(platform, storedRoomId.trim());
}

/**
 * Guard for provider I/O: canonical keys must never be sent to a provider, and a
 * key must never address a room on another platform. Returns a reason string when
 * the delivery target is unsafe, otherwise `null`.
 */
export function providerRoomTargetMismatch(
  platform: string,
  storedRoomId: string | null | undefined,
  remoteRoomId: string,
): string | null {
  const reference = storedRoomReference(storedRoomId ?? '');
  if (reference.kind === 'empty' || reference.kind === 'raw') return null;
  if (reference.platform !== platform) {
    return `stored room ${storedRoomId} does not belong to platform ${platform}`;
  }
  if (reference.remoteRoomId !== remoteRoomId) {
    return `stored room ${storedRoomId} resolves to ${reference.remoteRoomId}, not ${remoteRoomId}`;
  }
  return null;
}

function legacyRoomRegistered(handle: SqliteLike, platform: RoomPlatform, remoteRoomId: string): boolean {
  try {
    const row = handle
      .query('SELECT 1 AS present FROM chat_rooms WHERE id = ? AND platform = ? LIMIT 1')
      .get(remoteRoomId, platform);
    return row !== null && row !== undefined;
  } catch {
    return false;
  }
}

/**
 * Platforms that already know this remote room id — from the `room_keys`
 * registry or from a pre-0022 `chat_rooms` row.
 */
export function platformsForRemoteRoomId(remoteRoomId: string): RoomPlatform[] {
  const remote = remoteRoomId.trim();
  const handle = databaseHandle();
  if (!remote || !handle) return [];
  const found: RoomPlatform[] = [];
  for (const platform of ROOM_PLATFORMS) {
    let known = false;
    try {
      known = resolveRoomKeySync(platform, remote, handle as never) !== null;
    } catch {
      known = false;
    }
    if (!known) known = legacyRoomRegistered(handle, platform, remote);
    if (known) found.push(platform);
  }
  return found;
}

export type RoomResolutionFailure =
  | { ok: false; reason: 'invalid_platform'; platform: string }
  | { ok: false; reason: 'platform_mismatch'; platform: string; registered: RoomPlatform[] }
  | { ok: false; reason: 'platform_ambiguous'; registered: RoomPlatform[] };

export type RoomResolution =
  | { ok: true; roomKey: string; remoteRoomId: string; platform: RoomPlatform | null }
  | RoomResolutionFailure;

function classifyDestination(remoteRoomId: string, requestedPlatform?: string | null): RoomResolution | null {
  const remote = remoteRoomId.trim();
  const requested = requestedPlatform === undefined || requestedPlatform === null
    ? null
    : normalizeRoomPlatform(requestedPlatform);
  if (requestedPlatform !== undefined && requestedPlatform !== null && !requested) {
    return { ok: false, reason: 'invalid_platform', platform: String(requestedPlatform) };
  }

  const registered = platformsForRemoteRoomId(remote);
  let platform = requested;
  if (!platform) {
    if (registered.length === 1) platform = registered[0]!;
    else if (registered.length > 1) return { ok: false, reason: 'platform_ambiguous', registered };
    else platform = inferRoomPlatform(remote);
  } else if (registered.length > 0 && !registered.includes(platform)) {
    return { ok: false, reason: 'platform_mismatch', platform, registered };
  }

  return { ok: true, roomKey: platform ? canonicalRoomKey(platform, remote) : '', remoteRoomId: remote, platform };
}

/**
 * Classify one webhook/notification destination and resolve its canonical key.
 *
 * - An explicit platform that is already registered for the remote id on another
 *   platform is rejected (`platform_mismatch`).
 * - A remote id that exists on several platforms without an explicit platform is
 *   rejected (`platform_ambiguous`) instead of guessing.
 * - An unknown platform stays `null` so legacy provider inference can finish the
 *   job at dispatch time.
 */
export function resolveRemoteRoomDestination(
  remoteRoomId: string,
  requestedPlatform?: string | null,
): RoomResolution {
  return classifyDestination(remoteRoomId, requestedPlatform) ?? {
    ok: true,
    roomKey: '',
    remoteRoomId: remoteRoomId.trim(),
    platform: null,
  };
}

/** Async variant used by the webhook intake path; registers unknown rooms. */
export async function resolveRemoteRoomDestinationAsync(
  remoteRoomId: string,
  requestedPlatform?: string | null,
): Promise<RoomResolution> {
  const classification = classifyDestination(remoteRoomId, requestedPlatform);
  if (!classification || !classification.ok || !classification.platform) return classification ?? {
    ok: true,
    roomKey: '',
    remoteRoomId: remoteRoomId.trim(),
    platform: null,
  };
  const roomKey = await resolveCanonicalRoomKeyAsync(classification.platform, classification.remoteRoomId);
  return { ...classification, roomKey };
}

export function describeRoomResolutionFailure(failure: RoomResolutionFailure): string {
  switch (failure.reason) {
    case 'invalid_platform':
      return 'Invalid platform';
    case 'platform_mismatch':
      return 'Destination platform mismatch';
    default:
      return 'Destination matches multiple platforms; specify platform';
  }
}

/**
 * True when the migration has added `room_key` to the given table. Feature
 * detection keeps a single binary working against databases that have not been
 * migrated yet (rolling upgrade), and keeps pre-migration rows readable. The
 * answer is cached per database handle, so a process that talks to more than one
 * database never reuses another one's answer.
 */
export function hasRoomKeyColumn(table: 'message_inbox' | 'message_outbox' | 'scheduled_deliveries'): boolean {
  const handle = databaseHandle();
  if (!handle) return false;
  const cache = columnPresence.get(handle) ?? new Map<string, { at: number; present: boolean }>();
  columnPresence.set(handle, cache);
  const cached = cache.get(table);
  const now = Date.now();
  if (cached && (cached.present || now - cached.at < COLUMN_CACHE_TTL_MS)) return cached.present;
  let present = false;
  try {
    const rows = handle.query(`PRAGMA table_info(\`${table}\`)`).all() as Array<{ name?: unknown }>;
    present = rows.some(row => row?.name === ROOM_KEY_COLUMN);
  } catch {
    present = false;
  }
  cache.set(table, { at: now, present });
  return present;
}

/** Test seam: forget cached column probes for every known handle. */
export function resetRoomKeyColumnCache(): void {
  columnPresence.get(databaseHandle() ?? ({} as SqliteLike))?.clear();
}
