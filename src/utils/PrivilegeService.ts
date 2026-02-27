/**
 * @file src/utils/PrivilegeService.ts
 * @description Per-role privilege / quota system for ElastraX.
 *
 * Each role has a set of numeric quotas (rate limits, context size, etc.).
 * Default values come from environment variables; per-role overrides can be
 * stored in the `role_privileges` DB table.
 *
 * When a user holds multiple roles, the **most permissive** value for each
 * quota wins (i.e., the highest number, or -1 for unlimited).
 *
 * Environment variable naming convention:
 *   ROLE_PRIV_{ROLE}_{FIELD}
 *
 * Example:
 *   ROLE_PRIV_PREMIUM_MESSAGES_PER_WINDOW=30
 *   ROLE_PRIV_OWNER_CONTEXT_LIMIT=100
 *
 * If the env var is unset, a sensible hardcoded default is used.
 */

import { db } from '../db';
import { rolePrivileges } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logger } from './logger';

/** Numeric quotas attached to a role. */
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
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

/** Build the env-level defaults for a single role (env → hardcoded). */
function envDefaults(role: string): RolePrivileges {
  const hc = HARDCODED[role] || HARDCODED.user;
  return {
    maxMessagesPerWindow: envInt(role, 'MESSAGES_PER_WINDOW', hc.maxMessagesPerWindow),
    rateLimitWindowSec:   envInt(role, 'RATE_WINDOW_SEC',     hc.rateLimitWindowSec),
    contextLimit:         envInt(role, 'CONTEXT_LIMIT',       hc.contextLimit),
    maxDownloadMb:        envInt(role, 'MAX_DOWNLOAD_MB',     hc.maxDownloadMb),
  };
}

/**
 * Merge a value across multiple roles — "most permissive wins".
 * -1 (unlimited) always wins over any finite value.
 */
function mergeMax(values: number[]): number {
  if (values.includes(-1)) return -1;
  return Math.max(...values);
}

export class PrivilegeService {
  /** In-memory cache of DB overrides.  Keyed by role name. */
  private static dbCache = new Map<string, Partial<RolePrivileges>>();
  private static cacheLoadedAt = 0;
  private static readonly CACHE_TTL_MS = 60_000; // 1 minute

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Get the effective privileges for a single role (env defaults merged with DB overrides).
   */
  static async getForRole(role: string): Promise<RolePrivileges> {
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
   */
  static async getEffective(roles: string[]): Promise<RolePrivileges> {
    const all = await Promise.all(roles.map(r => this.getForRole(r)));
    return {
      maxMessagesPerWindow: mergeMax(all.map(p => p.maxMessagesPerWindow)),
      rateLimitWindowSec:   mergeMax(all.map(p => p.rateLimitWindowSec)),
      contextLimit:         mergeMax(all.map(p => p.contextLimit)),
      maxDownloadMb:        mergeMax(all.map(p => p.maxDownloadMb)),
    };
  }

  /**
   * Set a DB override for a specific role's privileges.
   * Pass `null` for a field to remove the override (revert to env default).
   */
  static async setOverride(role: string, field: keyof RolePrivileges, value: number | null): Promise<void> {
    // Upsert into role_privileges
    const existing = await db
      .select()
      .from(rolePrivileges)
      .where(eq(rolePrivileges.role, role))
      .limit(1);

    const colMap: Record<keyof RolePrivileges, string> = {
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
  static async resetToDefaults(role: string): Promise<void> {
    await db.delete(rolePrivileges).where(eq(rolePrivileges.role, role));
    this.dbCache.delete(role);
  }

  /**
   * Get the env default privileges for a role (no DB overrides applied).
   * Useful for showing "default" vs "current" in admin UIs.
   */
  static getDefaults(role: string): RolePrivileges {
    return envDefaults(role);
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private static async getDbOverrides(role: string): Promise<Partial<RolePrivileges>> {
    // Return from cache if fresh
    if (this.dbCache.has(role) && Date.now() - this.cacheLoadedAt < this.CACHE_TTL_MS) {
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
      this.cacheLoadedAt = Date.now();
      return overrides;
    } catch (err) {
      logger.error({ err, role }, '[PrivilegeService] Failed to load DB overrides');
      return {};
    }
  }
}
