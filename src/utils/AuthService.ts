/**
 * @file src/utils/AuthService.ts
 * @description Unified service for managing user roles, permissions, and privileges/quotas.
 */

import { db } from '../db';
import { userRoles, rolePrivileges } from '../db/schema';
import { eq, and, inArray, or } from 'drizzle-orm';
import { logger } from './logger';
import { IdentityService } from './IdentityService';

export type RoleName = 'user' | 'premium' | 'admin' | 'owner';

export const BUILTIN_ROLES: readonly string[] = ['user', 'premium', 'admin', 'owner'] as const;

export interface RolePrivileges {
  /** Max messages in a rate-limit window. -1 = unlimited. */
  maxMessagesPerWindow: number;
  /** Rate-limit window duration in seconds. */
  rateLimitWindowSec: number;
  /** Max conversation context messages sent to the LLM. */
  contextLimit: number;
  /** Max download file size in MB. -1 = unlimited. */
  maxDownloadMb: number;
}

export const PRIVILEGE_FIELDS = [
  'maxMessagesPerWindow',
  'rateLimitWindowSec',
  'contextLimit',
  'maxDownloadMb',
] as const;

export type PrivilegeField = (typeof PRIVILEGE_FIELDS)[number];

export interface AccessProfile {
  roles: string[];
  privileges: RolePrivileges;
}

// ── Hardcoded fallbacks (used when env is also unset) ───────────────────────
const HARDCODED: Record<string, RolePrivileges> = {
  user:    { maxMessagesPerWindow: 10, rateLimitWindowSec: 60,  contextLimit: 20,  maxDownloadMb: 25  },
  premium: { maxMessagesPerWindow: 30, rateLimitWindowSec: 60,  contextLimit: 50,  maxDownloadMb: 100 },
  admin:   { maxMessagesPerWindow: 30, rateLimitWindowSec: 60,  contextLimit: 50,  maxDownloadMb: 100 },
  owner:   { maxMessagesPerWindow: -1, rateLimitWindowSec: 60,  contextLimit: 100, maxDownloadMb: -1  },
};

/** Read an env-based privilege, falling back to the hardcoded default. */
function envInt(role: string, field: string, fallback: number): number {
  const key = `ROLE_PRIV_${role.toUpperCase()}_${field}`;
  const raw = process.env[key];
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return fallback;
}

function isValidPrivilegeValue(field: PrivilegeField, value: number): boolean {
  switch (field) {
    case 'maxMessagesPerWindow':
      return value === -1 || (value >= 1 && value <= 1_000_000);
    case 'rateLimitWindowSec':
      return value >= 1 && value <= 86_400;
    case 'contextLimit':
      return value === -1 || (value >= 1 && value <= 10_000);
    case 'maxDownloadMb':
      return value === -1 || (value >= 1 && value <= 1_024);
  }
}

/** Build the env-level defaults for a single role (env → hardcoded). */
function envDefaults(role: string): RolePrivileges {
  const hc = HARDCODED[role] || HARDCODED.user;
  const values: RolePrivileges = {
    maxMessagesPerWindow: envInt(role, 'MESSAGES_PER_WINDOW', hc.maxMessagesPerWindow),
    rateLimitWindowSec: envInt(role, 'RATE_WINDOW_SEC', hc.rateLimitWindowSec),
    contextLimit: envInt(role, 'CONTEXT_LIMIT', hc.contextLimit),
    maxDownloadMb: envInt(role, 'MAX_DOWNLOAD_MB', hc.maxDownloadMb),
  };
  for (const field of PRIVILEGE_FIELDS) {
    if (!isValidPrivilegeValue(field, values[field])) {
      values[field] = hc[field];
    }
  }
  return values;
}

/**
 * Merge a value across multiple roles — "most permissive wins".
 * -1 (unlimited) always wins over any finite value.
 */
function mergeMax(values: number[]): number {
  if (values.includes(-1)) return -1;
  return Math.max(...values);
}

/**
 * Merge a duration across multiple roles where SHORTER is more permissive
 * (e.g. rateLimitWindowSec). -1 is treated as "unset" and ignored unless
 * every value is -1.
 */
function mergeMin(values: number[]): number {
  const finite = values.filter((v) => v !== -1);
  if (finite.length === 0) return -1;
  return Math.min(...finite);
}

/** Owner id per platform; see AuthService.resolveOwnerId. */
function resolveOwnerIdForPlatform(platform: string): string | undefined {
  const specific = platform === 'telegram'
    ? process.env.BOT_OWNER_TELEGRAM_ID
    : platform === 'discord'
      ? process.env.BOT_OWNER_DISCORD_ID
      : undefined;
  return specific?.trim() || process.env.BOT_OWNER_JID?.trim();
}

function roomKeyFor(platform: string, scope: string): string {
  return `room:${platform}:${scope}`;
}

function legacyScopeFor(platform: string, scope: string): string {
  const prefix = `room:${platform}:`;
  return scope.startsWith(prefix) ? scope.slice(prefix.length) : scope;
}

function normalizeRoleScope(platform: string, scope: string): { scope: string; scopeRoomKey: string | null } {
  const legacyScope = legacyScopeFor(platform, scope);
  return {
    scope: legacyScope,
    scopeRoomKey: legacyScope === 'global' ? null : roomKeyFor(platform, legacyScope),
  };
}

export function isPrivilegeField(value: string | undefined): value is PrivilegeField {
  return value !== undefined && PRIVILEGE_FIELDS.includes(value as PrivilegeField);
}

type AuthDeps = {
  db: typeof import('../db').db;
  userRoles: typeof import('../db/schema').userRoles;
  rolePrivileges: typeof import('../db/schema').rolePrivileges;
};

export class AuthService {
  private static deps: AuthDeps = { db, userRoles, rolePrivileges };
  
  /** In-memory cache of DB overrides.  Keyed by role name. */
  private static dbCache = new Map<string, Partial<RolePrivileges>>();
  private static cacheLoadedAt = 0;
  private static readonly CACHE_TTL_MS = 60_000; // 1 minute

  static setDepsForTesting(deps: AuthDeps | null): void {
    this.deps = deps ?? { db, userRoles, rolePrivileges };
    this.dbCache.clear();
    this.cacheLoadedAt = 0;
  }

  // ── Roles API ──────────────────────────────────────────────────────────

  /**
   * The configured owner identifier for a platform.
   *
   * `BOT_OWNER_TELEGRAM_ID` / `BOT_OWNER_DISCORD_ID` take precedence for their
   * platform; otherwise `BOT_OWNER_JID` is used, which is what WhatsApp and any
   * platform whose ids share that format rely on.
   */
  static resolveOwnerId(platform: string = 'whatsapp'): string | undefined {
    return resolveOwnerIdForPlatform(platform);
  }

  static async resolveRoles(
    userId: string,
    chatId?: string,
    isPlatformAdmin?: boolean,
    senderPn?: string,
    platform: string = 'whatsapp',
  ): Promise<string[]> {
    const roles = new Set<string>(['user']);

    try {
      // Owner ids are per-platform: a Telegram user id is a numeric snowflake
      // and can never equal a WhatsApp JID, so a single variable would silently
      // never match on one of the two.
      const ownerJid = resolveOwnerIdForPlatform(platform);
      const ownerMatchUserId = ownerJid ? userId === ownerJid : false;
      const ownerMatchPn = ownerJid && senderPn ? senderPn === ownerJid : false;

      if (ownerJid && (ownerMatchUserId || ownerMatchPn)) {
        roles.add('owner');
        logger.info({ matchedVia: ownerMatchUserId ? 'userId' : 'senderPn' }, '[AuthService] Owner role matched');
      }

      let userIds: string[];
      let roleRows: Array<{ scope: string; role: string; scopeRoomKey?: string | null }>;
      const canonicalChatRoomKey = chatId ? roomKeyFor(platform, chatId) : null;

      try {
        const resolved = await IdentityService.getJidsAndRoles(userId, chatId, platform);
        userIds = resolved.jids;
        roleRows = resolved.roles;
        if (senderPn && !userIds.includes(senderPn)) {
          userIds.push(senderPn);
        }
      } catch (err) {
        logger.warn({ err, userId, senderPn }, '[AuthService] Identity role lookup failed');
        userIds = senderPn && senderPn !== userId ? [userId, senderPn] : [userId];
        roleRows = [];
      }

      const appliedRoles: string[] = [];
      for (const row of roleRows) {
        if (BUILTIN_ROLES.includes(row.role) && (
          row.scope === 'global'
          || (chatId !== undefined && row.scope === chatId)
          || (canonicalChatRoomKey !== null && (row.scope === canonicalChatRoomKey || row.scopeRoomKey === canonicalChatRoomKey))
        )) {
          roles.add(row.role);
          appliedRoles.push(row.role);
        }
      }

      if (isPlatformAdmin) {
        roles.add('admin');
        if (!appliedRoles.includes('admin')) {
          appliedRoles.push('admin');
        }
      }

      logger.debug(
        { userIds, chatId, appliedRoles, platformAdmin: isPlatformAdmin === true },
        '[AuthService] Roles resolved',
      );
      return Array.from(roles);
    } catch (err) {
      logger.error({ err, userId, senderPn }, '[AuthService] Failed to resolve roles');
      return ['user'];
    }
  }

  static canManageScope(actorRoles: readonly string[], targetScope: string, currentScope?: string, platform = 'whatsapp'): boolean {
    if (actorRoles.includes('owner')) return true;
    if (!actorRoles.includes('admin') || currentScope === undefined) return false;
    const target = legacyScopeFor(platform, targetScope);
    const current = legacyScopeFor(platform, currentScope);
    return target === current;
  }

  static assertRoleScopeAllowed(actorRoles: readonly string[], targetScope: string, currentScope?: string, platform = 'whatsapp'): void {
    if (!this.canManageScope(actorRoles, targetScope, currentScope, platform)) {
      throw new Error('You are not allowed to manage roles in that scope');
    }
  }

  static hasPermission(roles: string[], required: string): boolean {
    if (required === 'user') return true;
    if (roles.includes('owner')) return true;
    return roles.includes(required);
  }

  static async getAccessProfile(roles: string[]): Promise<AccessProfile> {
    const privileges = await this.getEffectivePrivileges(roles);
    return { roles, privileges };
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
    if (!BUILTIN_ROLES.includes(role)) {
      throw new Error(`Unsupported role: ${role}`);
    }
    if (!scope.trim()) {
      throw new Error('Role scope is required');
    }
    if (!platform.trim()) {
      throw new Error('Role platform is required');
    }
    const normalizedScope = normalizeRoleScope(platform, scope);
    scope = normalizedScope.scope;

    const { db, userRoles } = this.deps;
    logger.info({ role, scope, platform }, '[AuthService] setRole - start');

    const existing = await db
      .select()
      .from(userRoles)
      .where(and(
        eq(userRoles.userId, userId),
        eq(userRoles.platform, platform),
        eq(userRoles.scope, scope),
      ));

    if (existing.length > 0) {
      const current = existing[0]!;
      await db
        .update(userRoles)
        .set({ role, grantedBy, scopeRoomKey: normalizedScope.scopeRoomKey })
        .where(and(
          eq(userRoles.userId, userId),
          eq(userRoles.platform, platform),
          eq(userRoles.scope, scope),
        ));
      logger.info({ role, scope, platform, replacedRole: current.role === role ? undefined : current.role }, '[AuthService] setRole - updated');
    } else {
      await db.insert(userRoles).values({
        userId,
        platform,
        scope,
        scopeRoomKey: normalizedScope.scopeRoomKey,
        role,
        grantedBy,
        created_at: new Date(),
      });
      logger.info({ role, scope, platform }, '[AuthService] setRole - inserted');
    }
  }

  static async removeRole(
    userId: string,
    scope: string,
    role: string,
    platform: string = 'whatsapp',
  ): Promise<boolean> {
    const { db, userRoles } = this.deps;
    const normalizedScope = normalizeRoleScope(platform, scope);
    logger.info({ scope: normalizedScope.scope, role, platform }, '[AuthService] removeRole - start');

    const conditions = and(
      eq(userRoles.userId, userId),
      eq(userRoles.platform, platform),
      eq(userRoles.scope, normalizedScope.scope),
      eq(userRoles.role, role),
    );

    const existing = await db.select({ id: userRoles.id }).from(userRoles).where(conditions).limit(1);

    if (existing.length === 0) {
      logger.warn({ scope, role, platform }, '[AuthService] removeRole - no matching entry found');
      return false;
    }

    await db.delete(userRoles).where(conditions);
    logger.info({ scope, role, platform }, '[AuthService] removeRole - deleted');
    return true;
  }

  static async listRoles(
    scope: string,
    platform?: string,
  ): Promise<Array<{ userId: string; role: string; platform: string; scopeRoomKey?: string | null; grantedBy: string }>> {
    const { db, userRoles } = this.deps;
    const rows = await db
      .select({
        userId: userRoles.userId,
        role: userRoles.role,
        platform: userRoles.platform,
        scopeRoomKey: userRoles.scopeRoomKey,
        grantedBy: userRoles.grantedBy,
      })
      .from(userRoles)
      .where(platform
        ? and(
            or(eq(userRoles.scope, scope), eq(userRoles.scopeRoomKey, scope)),
            eq(userRoles.platform, platform),
          )
        : or(eq(userRoles.scope, scope), eq(userRoles.scopeRoomKey, scope)));
    return rows.map(row => row.scopeRoomKey ? row : ({ userId: row.userId, role: row.role, platform: row.platform, grantedBy: row.grantedBy }));
  }

  static async getUserRoles(
    userId: string,
    platform?: string,
  ): Promise<Array<{ scope: string; scopeRoomKey?: string | null; role: string; platform?: string }>> {
    const { db, userRoles } = this.deps;
    let userIds: string[];
    try {
      userIds = await IdentityService.getAllJids(userId);
    } catch {
      userIds = [userId];
    }

    const roleLookupCondition = userIds.length === 1 ? eq(userRoles.userId, userIds[0]!) : inArray(userRoles.userId, userIds);

    const rows = await db
      .select({
        scope: userRoles.scope,
        scopeRoomKey: userRoles.scopeRoomKey,
        role: userRoles.role,
        platform: userRoles.platform,
      })
      .from(userRoles)
      .where(platform
        ? and(roleLookupCondition, eq(userRoles.platform, platform))
        : roleLookupCondition);
    return rows.map(row => row.scopeRoomKey ? row : { scope: row.scope, role: row.role, platform: row.platform });
  }

  // ── Privileges API ──────────────────────────────────────────────────────────

  /**
   * Get the effective privileges for a single role (env defaults merged with DB overrides).
   */
  static async getPrivilegesForRole(role: string): Promise<RolePrivileges> {
    const defaults = envDefaults(role);
    const overrides = await this.getDbOverrides(role);
    return {
      maxMessagesPerWindow: overrides.maxMessagesPerWindow ?? defaults.maxMessagesPerWindow,
      rateLimitWindowSec:   overrides.rateLimitWindowSec   ?? defaults.rateLimitWindowSec,
      contextLimit:         overrides.contextLimit         ?? defaults.contextLimit,
      maxDownloadMb:        overrides.maxDownloadMb        ?? defaults.maxDownloadMb,
    };
  }

  /**
   * Compute the effective privileges for a user who holds multiple roles.
   * The most permissive value for each quota is used.
   * Batch-loads all role overrides in a single DB query for efficiency.
   */
  static async getEffectivePrivileges(roles: string[]): Promise<RolePrivileges> {
    const { db, rolePrivileges } = this.deps;
    // Expire the cache as a whole. A single shared `cacheLoadedAt` that is
    // refreshed by *partial* loads meant an already-cached role was never
    // revalidated as long as some other role was loaded more often than the TTL,
    // so a privilege change could take unbounded time to take effect.
    const now = Date.now();
    if (now - this.cacheLoadedAt >= this.CACHE_TTL_MS) this.dbCache.clear();
    const uncachedRoles = roles.filter(r => !this.dbCache.has(r));
    if (uncachedRoles.length >= 1) {
      try {
        const rows = await db
          .select()
          .from(rolePrivileges)
          .where(inArray(rolePrivileges.role, uncachedRoles));
        for (const row of rows) {
          const overrides: Partial<RolePrivileges> = {};
          if (row.maxMessagesPerWindow !== null) overrides.maxMessagesPerWindow = row.maxMessagesPerWindow;
          if (row.rateLimitWindowSec !== null) overrides.rateLimitWindowSec = row.rateLimitWindowSec;
          if (row.contextLimit !== null) overrides.contextLimit = row.contextLimit;
          if (row.maxDownloadMb !== null) overrides.maxDownloadMb = row.maxDownloadMb;
          this.dbCache.set(row.role, overrides);
        }
        // Cache empty results for roles not found in DB
        for (const role of uncachedRoles) {
          if (!this.dbCache.has(role)) this.dbCache.set(role, {});
        }
        this.cacheLoadedAt = now;
      } catch (err) {
        logger.error({ err, roles: uncachedRoles }, '[AuthService] Failed to batch-load DB overrides');
      }
    }

    const all = await Promise.all(roles.map(r => this.getPrivilegesForRole(r)));
    const result = {
      maxMessagesPerWindow: mergeMax(all.map(p => p.maxMessagesPerWindow)),
      // Shorter window = user can act sooner = more permissive
      rateLimitWindowSec:   mergeMin(all.map(p => p.rateLimitWindowSec)),
      contextLimit:         mergeMax(all.map(p => p.contextLimit)),
      maxDownloadMb:        mergeMax(all.map(p => p.maxDownloadMb)),
    };
    logger.debug(
      { roles, effective: result },
      '[AuthService] getEffectivePrivileges — merged privileges (most permissive wins)',
    );
    return result;
  }

  /**
   * Set a DB override for a specific role's privileges.
   * Pass `null` for a field to remove the override (revert to env default).
   */
  static async setPrivilegeOverride(role: string, field: PrivilegeField, value: number | null): Promise<void> {
    if (!BUILTIN_ROLES.includes(role)) {
      throw new Error(`Unsupported role: ${role}`);
    }
    if (value !== null && !isValidPrivilegeValue(field, value)) {
      throw new Error(`Invalid value for ${field}`);
    }

    const { db, rolePrivileges } = this.deps;
    logger.info({ role, field, value }, '[AuthService] setPrivilegeOverride — updating DB');
    // Upsert into role_privileges
    const existing = await db
      .select()
      .from(rolePrivileges)
      .where(eq(rolePrivileges.role, role))
      .limit(1);

    const colMap: Record<PrivilegeField, string> = {
      maxMessagesPerWindow: 'maxMessagesPerWindow',
      rateLimitWindowSec:   'rateLimitWindowSec',
      contextLimit:         'contextLimit',
      maxDownloadMb:        'maxDownloadMb',
    };

    const setData: Record<string, number | null> = { [colMap[field]]: value };

    if (existing.length > 0) {
      await db.update(rolePrivileges).set(setData).where(eq(rolePrivileges.role, role));
    } else {
      await db.insert(rolePrivileges).values({ role, ...setData });
    }

    // Invalidate cache
    this.dbCache.delete(role);
  }

  /**
   * Reset all DB overrides for a role (revert everything to env defaults).
   */
  static async resetPrivilegesToDefaults(role: string): Promise<void> {
    if (!BUILTIN_ROLES.includes(role)) {
      throw new Error(`Unsupported role: ${role}`);
    }
    const { db, rolePrivileges } = this.deps;
    logger.info({ role }, '[AuthService] resetPrivilegesToDefaults — clearing DB overrides');
    await db.delete(rolePrivileges).where(eq(rolePrivileges.role, role));
    this.dbCache.delete(role);
  }

  /**
   * Get the env default privileges for a role (no DB overrides applied).
   * Useful for showing "default" vs "current" in admin UIs.
   */
  static getDefaultPrivileges(role: string): RolePrivileges {
    return envDefaults(role);
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private static async getDbOverrides(role: string): Promise<Partial<RolePrivileges>> {
    const { db, rolePrivileges } = this.deps;
    // Whole-cache expiry, mirroring getEffectivePrivileges: a fresh entry for
    // one role must not make a stale entry for another look fresh.
    const now = Date.now();
    if (now - this.cacheLoadedAt >= this.CACHE_TTL_MS) this.dbCache.clear();
    if (this.dbCache.has(role)) {
      return this.dbCache.get(role)!;
    }

    try {
      const rows = await db
        .select()
        .from(rolePrivileges)
        .where(eq(rolePrivileges.role, role))
        .limit(1);

      const overrides: Partial<RolePrivileges> = {};
      if (rows.length > 0) {
        const row = rows[0];
        if (row.maxMessagesPerWindow !== null) overrides.maxMessagesPerWindow = row.maxMessagesPerWindow;
        if (row.rateLimitWindowSec !== null)   overrides.rateLimitWindowSec   = row.rateLimitWindowSec;
        if (row.contextLimit !== null)         overrides.contextLimit         = row.contextLimit;
        if (row.maxDownloadMb !== null)        overrides.maxDownloadMb        = row.maxDownloadMb;
      }

      this.dbCache.set(role, overrides);
      this.cacheLoadedAt = now;
      return overrides;
    } catch (err) {
      logger.error({ err, role }, '[AuthService] Failed to load DB overrides');
      return {};
    }
  }
}
