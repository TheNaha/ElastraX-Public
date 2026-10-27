/**
 * @file src/core/platforms.ts
 * @description The single source of truth for the messaging platforms this build ships.
 *
 * The platform list used to be repeated in five places, and the copies had
 * drifted apart:
 *
 *  - `src/tools/BaseTool.ts` advertised `['whatsapp', 'discord']` as the default
 *    set of platforms a tool may run on. `isToolAccessible()` filters on it, so
 *    on Telegram *no tool at all* was reachable: the model got an empty tool
 *    list and every slash command answered "unknown command".
 *  - `src/messaging/roomKeys.ts` kept its own `ROOM_PLATFORMS`, used to decide
 *    whether a room id is known on a platform. A Telegram room was therefore
 *    "unknown" everywhere, a numeric Telegram chat id was mis-inferred as
 *    Discord, and a Telegram reminder was resolved as a WhatsApp room and
 *    retired on first sight.
 *  - `src/webhooks/WebhookServer.ts` hard-coded `!== 'discord' && !== 'whatsapp'`
 *    so an explicitly targeted `platform: "telegram"` destination was rejected
 *    with 400.
 *  - `src/runtime/AppRuntime.ts` and `src/utils/IdentityService.ts` each
 *    re-implemented "which platform does this id belong to" with slightly
 *    different rules.
 *
 * Everything that needs to know "is this a platform we support?" now reads it
 * from here, so adding a platform is a one-line change instead of a hunt.
 */

/** Every messaging platform this build can talk to. */
export const SUPPORTED_PLATFORMS = ['whatsapp', 'discord', 'telegram'] as const;

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

/** True when `value` names a platform this build ships. */
export function isSupportedPlatform(value: unknown): value is SupportedPlatform {
  return typeof value === 'string' && (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Normalise a platform name. Returns `null` for anything that is not a
 * supported platform, so a caller can distinguish "unknown platform" from
 * "no platform given".
 */
export function normalizePlatform(value: unknown): SupportedPlatform | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return isSupportedPlatform(normalized) ? normalized : null;
}

/**
 * Best-effort platform guess from the shape of a raw provider room id.
 *
 * Only used when the room is not already registered on a platform. The rules
 * are deliberately conservative:
 *
 *  - a value carrying a WhatsApp suffix (`@g.us`, `@s.whatsapp.net`, `@lid`) is
 *    WhatsApp;
 *  - a Telegram supergroup/channel id is negative and starts with `-100`, which
 *    no other platform produces;
 *  - a bare positive number is *ambiguous* — Discord snowflakes and Telegram
 *    user ids are both numeric — so it is reported as Discord, which is the
 *    historical default. A room that is actually registered on Telegram is
 *    resolved from the registry before this is ever consulted.
 */
export function inferPlatformFromRoomId(remoteRoomId: string): SupportedPlatform | null {
  const value = remoteRoomId.trim();
  if (!value) return null;
  if (value.endsWith('@g.us') || value.endsWith('@s.whatsapp.net') || value.endsWith('@lid')) {
    return 'whatsapp';
  }
  if (value.includes('@')) return null;
  // Telegram supergroups and channels are `-100…`; Discord ids never are.
  if (/^-100\d+$/.test(value)) return 'telegram';
  if (/^\d{5,32}$/.test(value)) return 'discord';
  return null;
}
