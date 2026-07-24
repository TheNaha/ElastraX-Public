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
import { eq, inArray } from 'drizzle-orm';

type SessionValue = string | number | boolean | null | SessionValue[] | { [key: string]: SessionValue };
type SessionData = Record<string, SessionValue>;
type DbDeps = {
  db: typeof import('../db').db;
  flowSessions: typeof import('../db/schema').flowSessions;
};

/** State data for a single interactive flow step. */
export interface FlowSession {
  flow: string;
  step: string;
  data: SessionData;
  expiresAt: number;
}

/** Top-level session container for a single user, holding all of their active flows. */
export interface UserSession {
  activeFlow: string | null;
  flows: Record<string, FlowSession>;
}

export interface ActiveFlowEntry {
  flowId: string;
  flow: FlowSession;
}

/** Persistent session store backed by SQLite. Uses in-memory Map as write-through cache. */
export class SessionManager {
  private static sessions = new Map<string, UserSession>();
  private static dbLoaded = false;
  private static dbLoadPromise: Promise<void> | null = null;
  private static dbDepsPromise: Promise<DbDeps> | null = null;
  private static persistQueue = new Map<string, Promise<void>>();

  private static getDbDeps(): Promise<DbDeps> {
    if (!this.dbDepsPromise) {
      this.dbDepsPromise = Promise.all([
        import('../db'),
        import('../db/schema'),
      ]).then(([dbMod, schemaMod]) => ({
        db: dbMod.db,
        flowSessions: schemaMod.flowSessions,
      }));
    }
    return this.dbDepsPromise;
  }

  private static cloneSession(session: UserSession | null): UserSession | null {
    return session ? structuredClone(session) : null;
  }

  private static hasFlows(flows: Record<string, FlowSession>): boolean {
    for (const _ in flows) return true;
    return false;
  }

  private static selectFallbackActiveFlow(session: UserSession): void {
    if (session.activeFlow && session.flows[session.activeFlow]) {
      return;
    }

    let lastFlow: string | null = null;
    for (const flowId in session.flows) {
      lastFlow = flowId;
    }
    session.activeFlow = lastFlow;
  }

  private static pruneExpiredFlows(session: UserSession, now: number = Date.now()): boolean {
    let hasExpired = false;

    for (const flowId in session.flows) {
      const flow = session.flows[flowId];
      if (flow && now > flow.expiresAt) {
        delete session.flows[flowId];
        if (session.activeFlow === flowId) {
          session.activeFlow = null;
        }
        hasExpired = true;
      }
    }

    this.selectFallbackActiveFlow(session);
    return hasExpired;
  }

  /**
   * Lazily load all persisted sessions from the database on first access.
   * This ensures sessions survive container restarts.
   */
  private static async loadFromDB(): Promise<void> {
    if (this.dbLoaded) return;
    if (this.dbLoadPromise) return this.dbLoadPromise;

    this.dbLoadPromise = (async () => {
      try {
        const { db, flowSessions } = await this.getDbDeps();
        const rows = db.select().from(flowSessions).all();
        const now = Date.now();
        const expiredIds: string[] = [];

        for (const row of rows) {
          try {
            const session = JSON.parse(row.data) as UserSession;
            const hasExpired = this.pruneExpiredFlows(session, now);

            if (this.hasFlows(session.flows)) {
              this.sessions.set(row.id, session);
            } else if (hasExpired || !this.hasFlows(session.flows)) {
              expiredIds.push(row.id);
            }
          } catch {
            // Skip corrupt rows instead of failing startup.
          }
        }

        if (expiredIds.length > 0) {
          await db.delete(flowSessions).where(inArray(flowSessions.id, expiredIds)).run();
        }

        this.dbLoaded = true;
        
        // Start background GC for expired flows
        setInterval(() => {
          const currentTime = Date.now();
          for (const [key, session] of this.sessions.entries()) {
            const hasExpired = this.pruneExpiredFlows(session, currentTime);
            if (hasExpired) {
              if (!this.hasFlows(session.flows)) {
                this.sessions.delete(key);
                this.persistToDB(key, null);
              } else {
                this.persistToDB(key, session);
              }
            }
          }
        }, 5 * 60 * 1000).unref();
        logger.debug({ count: this.sessions.size, expiredPruned: expiredIds.length }, '[SessionManager] Loaded sessions from DB');
      } catch (err) {
        this.dbLoaded = false;
        logger.warn({ err }, '[SessionManager] Failed to load sessions from DB (non-fatal)');
      } finally {
        this.dbLoadPromise = null;
      }
    })();

    return this.dbLoadPromise;
  }

  private static async persistToDBInternal(key: string, session: UserSession | null): Promise<void> {
    try {
      const { db, flowSessions } = await this.getDbDeps();
      if (!session || !this.hasFlows(session.flows)) {
        await db.delete(flowSessions).where(eq(flowSessions.id, key)).run();
      } else {
        const data = JSON.stringify(session);
        await db.insert(flowSessions)
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

  /** Write-through: persist session state to SQLite. */
  private static persistToDB(key: string, session: UserSession | null): void {
    const snapshot = this.cloneSession(session);
    const previous = this.persistQueue.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.persistToDBInternal(key, snapshot))
      .finally(() => {
        if (this.persistQueue.get(key) === next) {
          this.persistQueue.delete(key);
        }
      });

    this.persistQueue.set(key, next);
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

    const hasExpired = this.pruneExpiredFlows(session);

    if (hasExpired && !this.hasFlows(session.flows)) {
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
   * Resolve the currently active flow without exposing the caller to raw session shape.
   * If the active flow pointer is stale but another flow remains, repair it in-place.
   */
  static getActiveFlow(userId: string, platform: string = 'whatsapp'): ActiveFlowEntry | null {
    const key = `${platform}:${userId}`;
    const session = this.get(userId, platform);

    if (!session) {
      return null;
    }

    if (!session.activeFlow || !session.flows[session.activeFlow]) {
      this.selectFallbackActiveFlow(session);

      if (!session.activeFlow || !session.flows[session.activeFlow]) {
        return null;
      }

      this.persistToDB(key, session);
    }

    return {
      flowId: session.activeFlow,
      flow: session.flows[session.activeFlow],
    };
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
         let lastFlow: string | null = null;
         for (const id in session.flows) {
           lastFlow = id;
         }
         session.activeFlow = lastFlow;
      }
      
      if (!this.hasFlows(session.flows)) {
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
