/**
 * @file src/core/roleAccess.ts
 * @description The one rule that decides whether a set of roles satisfies a
 * required role.
 *
 * The rule used to be written out in seven places:
 *
 *  - `src/utils/AuthService.ts` — `hasPermission` and a *dead* `meetsRequirement`
 *    that used a completely different rule (a weighted comparison under which
 *    `premium` satisfied `admin`);
 *  - `src/runtime/AppRuntime.ts` — `hasRequiredRoleFor`;
 *  - `src/tools/registry.ts` — `hasRole` and `hasRequiredRole` (two copies that
 *    differed only in the fallback set used when no roles were supplied);
 *  - `src/providers/telegram.ts` and `src/providers/discord.ts` — inline copies.
 *
 * They agreed on the happy path, but a rule that exists seven times is a rule
 * that will eventually exist eight times with a different answer. This module
 * is the single definition, and every caller imports it.
 */

/**
 * Whether a caller holding `roles` satisfies `required`.
 *
 * The rule is:
 *
 *  - `user` is satisfied by everyone — it is the implicit base role;
 *  - `owner` satisfies every level;
 *  - otherwise the caller must hold the required role *exactly*.
 *
 * Note that the roles are not ordered: `premium` does **not** satisfy `admin`.
 * The two are independent grants, and the weighted variant that treated them
 * as a ladder was the divergent copy this module replaces.
 */
export function roleSatisfies(
  roles: readonly string[] | undefined | null,
  required: string,
): boolean {
  if (required === 'user') return true;
  const held = roles ?? [];
  if (held.includes('owner')) return true;
  return held.includes(required);
}
