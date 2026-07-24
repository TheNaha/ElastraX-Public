/**
 * @file src/utils/RoleService.ts
 * @description Service for managing user roles and permissions in the bot.
 */

import { db } from '../db';
import { userRoles } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { logger } from './logger';
import { IdentityService } from './IdentityService';
import { PrivilegeService, type RolePrivileges } from './PrivilegeService';

export type RoleName = 'user' | 'premium' | 'admin' | 'owner';

export const BUILTIN_ROLES: readonly string[] = ['user', 'premium', 'admin', 'owner'] as const;

export interface AccessProfile {
  roles: string[];
  privileges: RolePrivileges;
}

type RoleDeps = {
  db: typeof import('../db').db;
  userRoles: typeof import('../db/schema').userRoles;
};

export class RoleService {
  private static deps: RoleDeps = { db, userRoles };

  static setDepsForTesting(deps: RoleDeps | null): void {
    this.deps = deps ?? { db, userRoles };
  }

  static async resolveRoles(
    userId: string,
    chatId?: string,
    isPlatformAdmin?: boolean,
    senderPn?: string,
  ): Promise<string[]> {
    const { db, userRoles } = this.deps;
    const roles = new Set<string>(['user']);

    try {
      const ownerJid = process.env.BOT_OWNER_JID;
      const ownerMatchUserId = ownerJid ? userId === ownerJid : false;
      const ownerMatchPn = ownerJid && senderPn ? senderPn === ownerJid : false;

      if (ownerJid && (ownerMatchUserId || ownerMatchPn)) {
        roles.add('owner');
        logger.info(
          { userId, senderPn, ownerJid, matchedVia: ownerMatchUserId ? 'userId' : 'senderPn' },
          '[RoleService] Owner matched via env BOT_OWNER_JID',
        );
      } else if (ownerJid) {
        logger.debug({ userId, senderPn, ownerJid }, '[RoleService] Owner check - no match');
      }

      let userIds: string[];
      try {
        userIds = await IdentityService.getAllJids(userId);
        if (senderPn && !userIds.includes(senderPn)) {
          userIds.push(senderPn);
        }
      } catch {
        userIds = senderPn && senderPn !== userId ? [userId, senderPn] : [userId];
      }

      logger.debug({ userIds, chatId }, '[RoleService] Querying DB for role entries');

      const roleLookupCondition = userIds.length === 1 ? eq(userRoles.userId, userIds[0]!) : inArray(userRoles.userId, userIds);

      const rows = await db
        .select({ scope: userRoles.scope, role: userRoles.role })
        .from(userRoles)
        .where(roleLookupCondition);

      if (rows.length > 0) {
        const appliedRoles: string[] = [];
        for (const row of rows) {
          if (row.scope === 'global' || row.scope === chatId) {
            roles.add(row.role);
            appliedRoles.push(row.role);
          }
        }
        logger.debug(
          {
            userId,
            dbRows: rows.length,
            appliedRoles,
          },
          '[RoleService] DB roles found',
        );
      }

      if (isPlatformAdmin) {
        roles.add('admin');
        logger.debug({ userId }, '[RoleService] Platform admin flag set - added admin role');
      }
    } catch (err) {
      logger.error({ err, userId, senderPn }, '[RoleService] Failed to resolve roles');
    }

    const result = Array.from(roles);
    logger.info({ userId, senderPn, chatId, roles: result }, '[RoleService] resolveRoles - final result');
    return result;
  }

  static hasPermission(roles: string[], required: string): boolean {
    if (required === 'user') return true;
    if (roles.includes('owner')) return true;
    return roles.includes(required);
  }

  static async getAccessProfile(roles: string[]): Promise<AccessProfile> {
    const privileges = await PrivilegeService.getEffective(roles);
    return { roles, privileges };
  }

  static async getEffectiveRole(userId: string, chatId?: string): Promise<RoleName | null> {
    try {
      const { db, userRoles } = this.deps;
      const rows = await db.select().from(userRoles).where(eq(userRoles.userId, userId));

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

  static meetsRequirement(role: RoleName, required: RoleName): boolean {
    const WEIGHT: Record<string, number> = { user: 0, premium: 1, admin: 1, owner: 2 };
    return (WEIGHT[role] ?? 0) >= (WEIGHT[required] ?? 0);
  }

  static async setRole(
    userId: string,
    role: string,
    scope: string,
    platform: string,
    grantedBy: string,
  ): Promise<void> {
    const { db, userRoles } = this.deps;
    logger.info({ userId, role, scope, platform, grantedBy }, '[RoleService] setRole - start');

    const existing = await db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.scope, scope), eq(userRoles.role, role)));

    if (existing.length > 0) {
      await db
        .update(userRoles)
        .set({ grantedBy })
        .where(and(eq(userRoles.userId, userId), eq(userRoles.scope, scope), eq(userRoles.role, role)));
      logger.info({ userId, role, scope }, '[RoleService] setRole - updated existing entry');
    } else {
      await db.insert(userRoles).values({
        userId,
        platform,
        scope,
        role,
        grantedBy,
        created_at: new Date(),
      });
      logger.info({ userId, role, scope }, '[RoleService] setRole - inserted new entry');
    }
  }

  static async removeRole(userId: string, scope: string, role?: string): Promise<boolean> {
    const { db, userRoles } = this.deps;
    logger.info({ userId, scope, role }, '[RoleService] removeRole - start');

    const conditions = role
      ? and(eq(userRoles.userId, userId), eq(userRoles.scope, scope), eq(userRoles.role, role))
      : and(eq(userRoles.userId, userId), eq(userRoles.scope, scope));

    const existing = await db.select({ id: userRoles.id }).from(userRoles).where(conditions).limit(1);

    if (existing.length === 0) {
      logger.warn({ userId, scope, role }, '[RoleService] removeRole - no matching entry found');
      return false;
    }

    await db.delete(userRoles).where(conditions);
    logger.info({ userId, scope, role }, '[RoleService] removeRole - deleted');
    return true;
  }

  static async listRoles(scope: string): Promise<Array<{ userId: string; role: string; grantedBy: string }>> {
    const { db, userRoles } = this.deps;
    return db
      .select({
        userId: userRoles.userId,
        role: userRoles.role,
        grantedBy: userRoles.grantedBy,
      })
      .from(userRoles)
      .where(eq(userRoles.scope, scope));
  }

  static async getUserRoles(userId: string): Promise<Array<{ scope: string; role: string }>> {
    const { db, userRoles } = this.deps;
    let userIds: string[];
    try {
      userIds = await IdentityService.getAllJids(userId);
    } catch {
      userIds = [userId];
    }

    const roleLookupCondition = userIds.length === 1 ? eq(userRoles.userId, userIds[0]!) : inArray(userRoles.userId, userIds);

    return db
      .select({
        scope: userRoles.scope,
        role: userRoles.role,
      })
      .from(userRoles)
      .where(roleLookupCondition);
  }
}
