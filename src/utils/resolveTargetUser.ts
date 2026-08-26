/**
 * @file src/utils/resolveTargetUser.ts
 * @description Unified user-identity resolver for any tool or command that
 *              needs to target a specific user.
 *
 * Supports 4 input sources (tried in priority order):
 *  1. **@mention**     — The first mentioned JID in the message.
 *  2. **quoted reply** — The sender of the message being replied to.
 *  3. **explicit arg** — A phone number, LID, or full JID typed directly.
 *  4. **sentinel**     — The LLM can output `"mentioned"` or `"quoted"` to
 *                        explicitly pick source 1 or 2.
 *
 * The resolved result includes the full JID (usable with Baileys APIs),
 * a human-friendly display string, and the source used.
 *
 * This module is designed to be the *single* place where user-targeting
 * logic lives.  Tools should never roll their own phone-number → JID
 * normalisation — use `resolveTargetUser()` instead.
 *
 * @example
 *   // Inside a tool's execute():
 *   const target = resolveTargetUser(args, ctx, 'user');
 *   if (!target) return t(lang, 'common.no_target_user');
 *   await ctx.updateGroupParticipants('remove', [target.jid]);
 */

import { MessageContext } from '../core/MessageContext';
import { jidBareId as bareId } from './jid';

// ─── Public Types ──────────────────────────────────────────────────────────────

/** How the user was resolved. */
export type ResolvedUserSource = 'mention' | 'quoted' | 'phone' | 'jid' | 'lid';

export interface ResolvedUser {
  /** Full JID ready for Baileys / Discord APIs (e.g. `628xxx@s.whatsapp.net` or `xxxx@lid`). */
  jid: string;
  /** Bare numeric / LID identifier for human-readable display (no @domain). */
  display: string;
  /** How the target was determined. */
  source: ResolvedUserSource;
}

// ─── Internals ─────────────────────────────────────────────────────────────────

/** True when all non-whitespace characters are digits. */
function isPureDigits(s: string): boolean {
  return /^\d+$/.test(s.replace(/[^0-9]/g, ''));
}

/**
 * Normalise a raw phone-number string into a `@s.whatsapp.net` JID.
 *  - Strips non-digits
 *  - Treats leading `0` as Indonesian local → prepends `62`
 *  - Appends `@s.whatsapp.net`
 */
function phoneToJid(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return null;
  const normalised = digits.startsWith('0') ? `62${digits.slice(1)}` : digits;
  return `${normalised}@s.whatsapp.net`;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve the target user from tool arguments and message context.
 *
 * @param args    Tool arguments object (from LLM or slash-command parser).
 * @param ctx     The current message context.
 * @param argName The key in `args` that holds the user identifier (default `'user'`).
 * @returns       A `ResolvedUser` or `null` if no valid target could be determined.
 *
 * ### Resolution order
 *
 * | Priority | Condition | Source |
 * |----------|-----------|--------|
 * | 1 | `args[argName]` is `"mentioned"`, **or** arg is absent/empty and `ctx.mentionedIds` has entries | First @mention |
 * | 2 | `args[argName]` is `"quoted"`, **or** arg is absent/empty and `ctx.quoted?.senderId` exists | Quoted sender |
 * | 3 | `args[argName]` is a full JID (contains `@`) | Direct JID |
 * | 4 | `args[argName]` is a string of digits | Phone → JID |
 *
 * When the arg contains an explicit value (not a sentinel and not empty) it
 * takes precedence over contextual sources (mention / quote).
 */
export function resolveTargetUser(
  args: Record<string, unknown>,
  ctx: MessageContext,
  argName: string = 'user',
): ResolvedUser | null {
  const raw = typeof args[argName] === 'string' ? (args[argName] as string).trim() : '';

  // ── Sentinel: explicit "mentioned" ───────────────────────────────────────
  if (raw.toLowerCase() === 'mentioned') {
    const id = ctx.mentionedIds?.[0];
    if (id) return { jid: id, display: bareId(id), source: 'mention' };
    // Fall through if there's nothing mentioned
  }

  // ── Sentinel: explicit "quoted" ──────────────────────────────────────────
  if (raw.toLowerCase() === 'quoted') {
    const id = ctx.quoted?.senderId;
    if (id) return { jid: id, display: bareId(id), source: 'quoted' };
  }

  // ── Explicit value provided (not a sentinel) ────────────────────────────
  if (raw && raw !== 'mentioned' && raw !== 'quoted') {
    // Already a full JID?
    if (raw.includes('@')) {
      const source: ResolvedUserSource = raw.endsWith('@lid') ? 'lid' : 'jid';
      return { jid: raw, display: bareId(raw), source };
    }

    // Pure digits → treat as phone number
    if (isPureDigits(raw)) {
      const jid = phoneToJid(raw);
      if (jid) return { jid, display: bareId(jid), source: 'phone' };
    }

    // Might be a Discord snowflake or other opaque identifier
    if (raw.length > 5) {
      return { jid: raw, display: raw, source: 'jid' };
    }

    return null;
  }

  // ── No explicit arg — try contextual sources ─────────────────────────────
  // Priority: mention > quoted
  if (ctx.mentionedIds && ctx.mentionedIds.length > 0) {
    const id = ctx.mentionedIds[0];
    return { jid: id, display: bareId(id), source: 'mention' };
  }

  if (ctx.quoted?.senderId) {
    const id = ctx.quoted.senderId;
    return { jid: id, display: bareId(id), source: 'quoted' };
  }

  return null;
}

/**
 * Convenience: resolve *all* mentioned users (not just the first).
 * Useful for batch operations like `/kick @A @B @C`.
 *
 * Falls back to the single-target resolver for non-mention sources.
 */
export function resolveAllTargetUsers(
  args: Record<string, unknown>,
  ctx: MessageContext,
  argName: string = 'user',
): ResolvedUser[] {
  // If multiple people are mentioned, return all of them
  if (ctx.mentionedIds && ctx.mentionedIds.length > 1) {
    return ctx.mentionedIds.map((id) => ({
      jid: id,
      display: bareId(id),
      source: 'mention' as const,
    }));
  }

  // Otherwise delegate to single-target
  const single = resolveTargetUser(args, ctx, argName);
  return single ? [single] : [];
}
