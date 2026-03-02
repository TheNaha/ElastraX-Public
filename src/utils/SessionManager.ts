/**
 * @file src/utils/SessionManager.ts
 * @description Persistent session store for multi-step interactive flows.
 *
 * When a tool needs to collect information across several user messages (a "wizard"),
 * it uses `SessionManager` to persist step data between message events.  The agent's
 * `FlowHandler` checks for an active session before routing messages to the LLM.
 *
 * Session keying:
 *  Sessions are keyed by `"${platform}:${userId}"` to prevent cross-platform
 *  collisions when the same user interacts via both WhatsApp and Discord.
 *
 * Persistence:
 *  Sessions are stored in both an in-memory `Map` (for fast reads) and the
 *  `flow_sessions` SQLite table (for crash recovery). Every `set()` and `clear()`
 *  operation writes through to both stores.
 *
 * Expiry:
 *  Each flow has a configurable TTL (default 300 seconds / 5 minutes).  Expired
 *  flows are pruned lazily when `get()` is called.
 */

import { logger } from './logger';

/** State data for a single interactive flow step. */
export interface FlowSession {
  flow: string;
  step: string;
  data: Record<string, any>;
  expiresAt: number;
}

/** Top-level session container for a single user, holding all of their active flows. */
export interface UserSession {
  activeFlow: string | null;
  flows: Record<string, FlowSession>;
}

/** Persistent session store backed by SQLite. Uses in-memory Map as write-through cache. */
export class SessionManager {
  private static sessions = new Map<string, UserSession>();
  private static dbLoaded = false;

  /**
   * Lazily load all persisted sessions from the database on first access.
   * This ensures sessions survive container restarts.
   */
  private static async loadFromDB(): Promise<void> {
    if (this.dbLoaded) return;
    this.dbLoaded = true;
    try {
      // Dynamic import to avoid circular dependency with db module
      const { db } = await import('../db');
      const { flowSessions } = await import('../db/schema');
      const { inArray } = await import('drizzle-orm');
      const rows = db.select().from(flowSessions).all();
      const now = Date.now();
      const expiredIds: string[] = [];

      for (const row of rows) {
        try {
          const session = JSON.parse(row.data) as UserSession;
          // Prune expired flows during load
          let hasExpired = false;
          for (const [flowId, flow] of Object.entries(session.flows)) {
            if (now > flow.expiresAt) {
              delete session.flows[flowId];
              if (session.activeFlow === flowId) session.activeFlow = null;
              hasExpired = true;
            }
          }
          if (Object.keys(session.flows).length > 0) {
            this.sessions.set(row.id, session);
          } else if (hasExpired) {
            // Collect ID to clean up fully expired session from DB in bulk
            expiredIds.push(row.id);
          }
        } catch { /* skip corrupt rows */ }
      }

      if (expiredIds.length > 0) {
        db.delete(flowSessions).where(inArray(flowSessions.id, expiredIds)).run();
      }

      logger.debug({ count: this.sessions.size, expiredPruned: expiredIds.length }, '[SessionManager] Loaded sessions from DB');
    } catch (err) {
      logger.warn({ err }, '[SessionManager] Failed to load sessions from DB (non-fatal)');
    }
  }

  /** Write-through: persist session state to SQLite. */
  private static persistToDB(key: string, session: UserSession | null): void {
    try {
      // Dynamic import to avoid circular dependency
      const { db } = require('../db');
      const { flowSessions } = require('../db/schema');
      if (!session || Object.keys(session.flows).length === 0) {
        db.delete(flowSessions).where(require('drizzle-orm').eq(flowSessions.id, key)).run();
      } else {
        const data = JSON.stringify(session);
        db.insert(flowSessions)
          .values({ id: key, data, updated_at: new Date() })
          .onConflictDoUpdate({
            target: flowSessions.id,
            set: { data, updated_at: new Date() },
          })
          .run();
      }
    } catch (err) {
      logger.warn({ err, key }, '[SessionManager] Failed to persist session to DB');
    }
  }

  /**
   * Create or update a flow session for the given user.
   */
  static set(userId: string, flowId: string, flowData: Omit<FlowSession, 'expiresAt'>, platform: string = 'whatsapp', ttlSeconds: number = 300) {
    const key = `${platform}:${userId}`;
    
    if (!this.sessions.has(key)) {
      this.sessions.set(key, { activeFlow: null, flows: {} });
    }

    const session = this.sessions.get(key)!;
    
    session.flows[flowId] = {
      ...flowData,
      expiresAt: Date.now() + (ttlSeconds * 1000)
    };
    session.activeFlow = flowId;
    
    this.persistToDB(key, session);
    logger.debug({ userId, flowId }, '[SessionManager] Flow updated');
  }

  /**
   * Retrieve the session for a user, pruning any expired flows in the process.
   */
  static get(userId: string, platform: string = 'whatsapp'): UserSession | null {
    const key = `${platform}:${userId}`;
    const session = this.sessions.get(key);
    
    if (!session) return null;

    // Cleanup expired flows
    let hasExpired = false;
    for (const [flowId, flow] of Object.entries(session.flows)) {
      if (Date.now() > flow.expiresAt) {
        delete session.flows[flowId];
        if (session.activeFlow === flowId) {
          session.activeFlow = null;
        }
        hasExpired = true;
      }
    }

    if (hasExpired && Object.keys(session.flows).length === 0) {
      this.sessions.delete(key);
      this.persistToDB(key, null);
      return null;
    }

    if (hasExpired) {
      this.persistToDB(key, session);
    }

    return session;
  }

  /**
   * Remove a specific flow from the user's session.
   */
  static clear(userId: string, flowId: string, platform: string = 'whatsapp') {
    const key = `${platform}:${userId}`;
    const session = this.sessions.get(key);
    
    if (session && session.flows[flowId]) {
      delete session.flows[flowId];
      if (session.activeFlow === flowId) {
         const remainingFlows = Object.keys(session.flows);
         session.activeFlow = remainingFlows.length > 0 ? remainingFlows[remainingFlows.length - 1] : null;
      }
      
      if (Object.keys(session.flows).length === 0) {
        this.sessions.delete(key);
        this.persistToDB(key, null);
      } else {
        this.persistToDB(key, session);
      }
      logger.debug({ userId, flowId }, '[SessionManager] Flow cleared');
    }
  }

  /**
   * Initialize the session manager by loading persisted sessions from DB.
   * Call once during startup.
   */
  static async initialize(): Promise<void> {
    await this.loadFromDB();
  }
}
