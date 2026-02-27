/**
 * @file src/utils/RoleService.ts
 * @description Service for managing user roles/permissions in the bot.
 *
 * Role hierarchy:  owner > admin > user
 *
 * Roles can be scoped:
 *  - `global`   — Applies everywhere (all groups + DMs).
 *  - `<chatId>` — Applies only within the specific group/chat.
 *
 * The bot owner (BOT_OWNER_JID / Discord guild owner) always has implicit `owner` role; 
 * this is never stored in the DB.
 *
 * When checking permissions the lookup order is:
 *  1. Env-based owner check (BOT_OWNER_JID).
 *  2. Chat-scoped DB role (e.g. admin in a specific group).
 *  3. Global DB role.
 *  4. Platform-native check (WhatsApp group admin / Discord permissions).
 *  5. Default: `user`.
 */

import { db } from '../db';
import { userRoles } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from './logger';

export type RoleName = 'user' | 'admin' | 'owner';

const ROLE_WEIGHT: Record<RoleName, number> = {
  user: 0,
  admin: 1,
  owner: 2,
};

export class RoleService {
  /**
   * Check if `role` meets or exceeds `required`.
   */
  static meetsRequirement(role: RoleName, required: RoleName): boolean {
    return ROLE_WEIGHT[role] >= ROLE_WEIGHT[required];
  }

  /**
   * Look up the effective DB role for a user.
   * Returns the highest-priority role (chat-scoped beats global; higher rank wins).
   */
  static async getEffectiveRole(userId: string, chatId?: string): Promise<RoleName | null> {
    try {
      const rows = await db
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, userId));

      if (rows.length === 0) return null;

      let best: RoleName | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (const row of rows) {
        const role = row.role as RoleName;
        // Chat-scoped match takes priority weight boost
        const isScoped = chatId && row.scope === chatId;
        const isGlobal = row.scope === 'global';

        if (!isScoped && !isGlobal) continue;

        const currentScore = ROLE_WEIGHT[role] + (isScoped ? 0.5 : 0);
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
   * Set a user's role. Upserts by (userId, scope).
   */
  static async setRole(
    userId: string,
    role: RoleName,
    scope: string,
    platform: string,
    grantedBy: string,
  ): Promise<void> {
    // Check if exists
    const existing = await db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.scope, scope)));

    if (existing.length > 0) {
      await db
        .update(userRoles)
        .set({ role, grantedBy })
        .where(and(eq(userRoles.userId, userId), eq(userRoles.scope, scope)));
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
   * Remove a user's role for a given scope.
   */
  static async removeRole(userId: string, scope: string): Promise<boolean> {
    const existing = await db
      .select({ id: userRoles.id })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.scope, scope)))
      .limit(1);

    if (existing.length === 0) return false;

    await db
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.scope, scope)));
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
