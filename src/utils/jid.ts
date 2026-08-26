/**
 * @file src/utils/jid.ts
 * @description Shared JID parsing helpers (single source of truth — was
 * previously duplicated across permissions.ts, resolveTargetUser.ts, RoleTool).
 */

/**
 * Lenient bare-id extraction used for display tags:
 * `"628123:some:device@s.whatsapp.net"` → `"628123"`.
 * Falls back to the raw input when it is not JID-shaped.
 */
export function jidBareId(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/**
 * Strict user-part extraction: returns the part before `@`, or undefined when
 * the input is empty or has no `@` separator (i.e. not a real JID).
 */
export function jidUser(jid: string | undefined): string | undefined {
  if (!jid) return undefined;
  const at = jid.indexOf('@');
  return at > 0 ? jid.slice(0, at) : undefined;
}
