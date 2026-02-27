/**
 * @file src/utils/RoleService.ts
 * @description Service for managing user roles/permissions in the bot.
 *
 * V7.11 Role Model — set-based (a user can hold multiple roles simultaneously):
 *
 *  | Role      | Scope    | Source                                          |
 *  |-----------|----------|-------------------------------------------------|
 *  | `user`    | global   | Implicit — every user has this role.             |
 *  | `premium` | global   | Explicitly granted in DB.                       |
 *  | `admin`   | per-room | DB grant OR platform-native (WA/Discord admin). |
 *  | `owner`   | global   | BOT_OWNER_JID env var OR DB grant.              |
 *
 * "premium" and "admin" are **parallel** (same weight, mutually exclusive tool access).
 * Only "owner" subsumes both — an owner can use any tool.
 *
 * Roles can be scoped:
 *  - `global`   — Applies everywhere (all groups + DMs).
 *  - `<chatId>` — Applies only within the specific group/chat.
 *
 * When resolving the full role set the lookup order is:
 *  1. Everyone starts with `user`.
 *  2. Env-based owner check (BOT_OWNER_JID) → adds `owner`.
 *  3. DB roles (global + chat-scoped) → adds each stored role.
 *  4. Platform-native admin (if `isPlatformAdmin` flag is set) → adds `admin`.
 */

import { db } from '../db';
import { userRoles } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from './logger';

/** Built-in role names.  Custom roles are also allowed as plain strings. */
export type RoleName = 'user' | 'premium' | 'admin' | 'owner';

/** All built-in role names for validation. */
export const BUILTIN_ROLES: readonly string[] = ['user', 'premium', 'admin', 'owner'] as const;

export class RoleService {
  // ── Role Resolution ────────────────────────────────────────────────────

  /**
   * Compute the full set of roles a user holds in a given context.
   *
   * @param userId          User identifier (JID / Discord ID).
   * @param chatId          Current chat/group ID (undefined for global-only check).
   * @param isPlatformAdmin Whether the platform reports this user as a native
   *                        group admin (WA group admin / Discord Administrator).
   * @returns Array of role names the user holds (always includes `'user'`).
   */
  static async resolveRoles(
    userId: string,
    chatId?: string,
    isPlatformAdmin?: boolean,
  ): Promise<string[]> {
    const roles = new Set<string>(['user']);

    try {
      // 1. Env owner
      if (process.env.BOT_OWNER_JID && userId === process.env.BOT_OWNER_JID) {
        roles.add('owner');
      }

      // 2. DB roles (global + per-room)
      const rows = await db
        .select({ scope: userRoles.scope, role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, userId));

      for (const row of rows) {
        if (row.scope === 'global' || row.scope === chatId) {
          roles.add(row.role);
        }
      }

      // 3. Platform-native admin
      if (isPlatformAdmin) {
        roles.add('admin');
      }
    } catch (err) {
      logger.error({ err, userId }, '[RoleService] Failed to resolve roles');
    }

    return Array.from(roles);
  }

  // ── Permission Check ──────────────────────────────────────────────────

  /**
   * Check whether a set of user roles satisfies a required role.
   *
   * Rules:
   *  - `'user'`    → always true (everyone is a user).
   *  - `'owner'`   → user must have `'owner'` in their set.
   *  - `'premium'` → user must have `'premium'` OR `'owner'`.
   *  - `'admin'`   → user must have `'admin'` OR `'owner'`.
   *  - Any other    → user must have that exact role OR `'owner'`.
   */
  static hasPermission(roles: string[], required: string): boolean {
    if (required === 'user') return true;
    if (roles.includes('owner')) return true;
    return roles.includes(required);
  }

  // ── Legacy convenience (used by existing callers) ─────────────────────

  /**
   * Look up the highest-weight DB role for a user.
   * @deprecated Prefer `resolveRoles` for the full picture.
   */
  static async getEffectiveRole(userId: string, chatId?: string): Promise<RoleName | null> {
    try {
      const rows = await db
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, userId));

      if (rows.length === 0) return null;

      const WEIGHT: Record<string, number> = { user: 0, premium: 1, admin: 1, owner: 2 };

      let best: RoleName | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (const row of rows) {
        const role = row.role as RoleName;
        const isScoped = chatId && row.scope === chatId;
        const isGlobal = row.scope === 'global';

        if (!isScoped && !isGlobal) continue;

        const currentScore = (WEIGHT[role] ?? 0) + (isScoped ? 0.5 : 0);
        if (currentScore > bestScore) {
          best = role;
          bestScore = currentScore;
        }
      }

      return best;
    } catch (err) {
      logger.error({ err, userId }, '[RoleService] Failed to fetch effective role');
      return null;
    }
  }

  /**
   * Check if `role` meets or exceeds `required` in the traditional hierarchy.
   * @deprecated Prefer `hasPermission` with a full role set.
   */
  static meetsRequirement(role: RoleName, required: RoleName): boolean {
    const WEIGHT: Record<string, number> = { user: 0, premium: 1, admin: 1, owner: 2 };
    return (WEIGHT[role] ?? 0) >= (WEIGHT[required] ?? 0);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────

  /**
   * Set a user's role. Upserts by (userId, scope, role).
   * A user can hold multiple different roles in the same scope.
   */
  static async setRole(
    userId: string,
    role: string,
    scope: string,
    platform: string,
    grantedBy: string,
  ): Promise<void> {
    const existing = await db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.scope, scope), eq(userRoles.role, role)));

    if (existing.length > 0) {
      // Already has this exact role in this scope — update grantedBy
      await db
        .update(userRoles)
        .set({ grantedBy })
        .where(and(eq(userRoles.userId, userId), eq(userRoles.scope, scope), eq(userRoles.role, role)));
    } else {
      await db.insert(userRoles).values({
        userId,
        platform,
        scope,
        role,
        grantedBy,
        created_at: new Date(),
      });
    }
  }

  /**
   * Remove a specific role from a user in a given scope.
   */
  static async removeRole(userId: string, scope: string, role?: string): Promise<boolean> {
    const conditions = role
      ? and(eq(userRoles.userId, userId), eq(userRoles.scope, scope), eq(userRoles.role, role))
      : and(eq(userRoles.userId, userId), eq(userRoles.scope, scope));

    const existing = await db
      .select({ id: userRoles.id })
      .from(userRoles)
      .where(conditions)
      .limit(1);

    if (existing.length === 0) return false;

    await db.delete(userRoles).where(conditions);
    return true;
  }

  /**
   * List all roles for a given scope (e.g. list all admins of a group).
   */
  static async listRoles(scope: string): Promise<Array<{ userId: string; role: string; grantedBy: string }>> {
    const rows = await db
      .select({
        userId: userRoles.userId,
        role: userRoles.role,
        grantedBy: userRoles.grantedBy,
      })
      .from(userRoles)
      .where(eq(userRoles.scope, scope));
    return rows;
  }

  /**
   * Get all role entries for a specific user.
   */
  static async getUserRoles(userId: string): Promise<Array<{ scope: string; role: string }>> {
    const rows = await db
      .select({
        scope: userRoles.scope,
        role: userRoles.role,
      })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
    return rows;
  }
}
