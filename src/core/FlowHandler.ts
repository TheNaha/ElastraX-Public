import { MessageContext } from './MessageContext';
import { logger } from '../utils/logger';
import { t } from '../utils/i18n';
import { CANCEL_COMMANDS } from './constants';
import { eq, inArray } from 'drizzle-orm';

type SessionValue = string | number | boolean | null | SessionValue[] | { [key: string]: SessionValue };
type SessionData = Record<string, SessionValue>;
type DbDeps = {
  db: typeof import('../db').db;
  flowSessions: typeof import('../db/schema').flowSessions;
};

export interface FlowSession {
  flow: string;
  step: string;
  data: SessionData;
  expiresAt: number;
}

export interface UserSession {
  activeFlow: string | null;
  flows: Record<string, FlowSession>;
}

export interface ActiveFlowEntry {
  flowId: string;
  flow: FlowSession;
}

export type FlowProcessor = (ctx: MessageContext, activeFlowData: FlowSession, flowId: string) => Promise<void>;

export class FlowHandler {
  private static flows: Record<string, FlowProcessor> = {};
  private static sessions = new Map<string, UserSession>();
  private static dbLoaded = false;
  private static dbLoadPromise: Promise<void> | null = null;
  private static dbDepsPromise: Promise<DbDeps> | null = null;
  private static persistQueue = new Map<string, Promise<void>>();
  private static gcInterval: ReturnType<typeof setInterval> | null = null;

  static register(flowName: string, processor: FlowProcessor) {
    this.flows[flowName] = processor;
    logger.debug({ flowName }, '[FlowHandler] Registered flow processor');
  }

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

  static async initialize(): Promise<void> {
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
              if (!this.sessions.has(row.id)) {
                this.sessions.set(row.id, session);
              } else {
                const memSession = this.sessions.get(row.id)!;
                for (const flowId in session.flows) {
                  if (!memSession.flows[flowId]) {
                    memSession.flows[flowId] = session.flows[flowId];
                  }
                }
                if (!memSession.activeFlow) {
                  memSession.activeFlow = session.activeFlow;
                }
              }
            } else if (hasExpired || !this.hasFlows(session.flows)) {
              expiredIds.push(row.id);
            }
          } catch {
            // Ignore bad rows
          }
        }

        if (expiredIds.length > 0) {
          await db.delete(flowSessions).where(inArray(flowSessions.id, expiredIds)).run();
        }

        this.dbLoaded = true;
        
        this.gcInterval = setInterval(() => {
          const currentTime = Date.now();
          for (const [key, session] of this.sessions.entries()) {
            const hasExpired = this.pruneExpiredFlows(session, currentTime);
            if (hasExpired) {
              if (!this.hasFlows(session.flows)) {
                this.sessions.delete(key);
                this.persistToDB(key);
              } else {
                this.persistToDB(key);
              }
            }
          }
        }, 5 * 60 * 1000);
        
        const interval = this.gcInterval as unknown as { unref?: () => void };
        if (interval && typeof interval.unref === 'function') {
          interval.unref();
        }
        logger.debug({ count: this.sessions.size, expiredPruned: expiredIds.length }, '[FlowHandler] Loaded sessions from DB');
      } catch (err) {
        this.dbLoaded = false;
        logger.warn({ err }, '[FlowHandler] Failed to load sessions from DB (non-fatal)');
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
      logger.warn({ err, key }, '[FlowHandler] Failed to persist session to DB');
    }
  }

  private static persistToDB(key: string): void {
    const previous = this.persistQueue.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => {
        const current = this.sessions.get(key);
        if (!current || !this.hasFlows(current.flows)) {
          return this.persistToDBInternal(key, null);
        } else {
          return this.persistToDBInternal(key, this.cloneSession(current));
        }
      })
      .finally(() => {
        if (this.persistQueue.get(key) === next) {
          this.persistQueue.delete(key);
        }
      });

    this.persistQueue.set(key, next);
  }

  static setSession(userId: string, flowId: string, flowData: Omit<FlowSession, 'expiresAt'>, platform: string = 'whatsapp', ttlSeconds: number = 300) {
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
    
    this.persistToDB(key);
    logger.debug({ userId, flowId }, '[FlowHandler] Flow session updated');
  }

  static getSession(userId: string, platform: string = 'whatsapp'): UserSession | null {
    const key = `${platform}:${userId}`;
    const session = this.sessions.get(key);
    
    if (!session) return null;

    const hasExpired = this.pruneExpiredFlows(session);

    if (hasExpired && !this.hasFlows(session.flows)) {
      this.sessions.delete(key);
      this.persistToDB(key);
      return null;
    }

    if (hasExpired) {
      this.persistToDB(key);
    }

    return session;
  }

  static getActiveFlow(userId: string, platform: string = 'whatsapp'): ActiveFlowEntry | null {
    const key = `${platform}:${userId}`;
    const session = this.getSession(userId, platform);

    if (!session) {
      return null;
    }

    if (!session.activeFlow || !session.flows[session.activeFlow]) {
      this.selectFallbackActiveFlow(session);

      if (!session.activeFlow || !session.flows[session.activeFlow]) {
        return null;
      }

      this.persistToDB(key);
    }

    return {
      flowId: session.activeFlow,
      flow: session.flows[session.activeFlow],
    };
  }

  static clearSession(userId: string, flowId: string, platform: string = 'whatsapp') {
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
      }
      this.persistToDB(key);
      logger.debug({ userId, flowId }, '[FlowHandler] Flow session cleared');
    }
  }

  static async handle(ctx: MessageContext): Promise<boolean> {
    const activeFlow = this.getActiveFlow(ctx.senderId, ctx.platform);

    if (!activeFlow) {
      return false;
    }

    const { flowId, flow } = activeFlow;

    const flowProcessor = this.flows[flow.flow];
    if (flowProcessor) {
      if (ctx.text.startsWith('/')) {
         if (CANCEL_COMMANDS.includes(ctx.text.trim())) {
            this.clearSession(ctx.senderId, flowId, ctx.platform);
            await ctx.react?.('✅');
            await ctx.reply(t(ctx.language, 'flow.cancelled'));
            return true;
         }
         await ctx.reply(t(ctx.language, 'flow.in_progress_warning', { cmd: ctx.text.trim() }) || 'You are currently in an active process. Please complete it, or type /cancel to exit.');
         return true;
      }

      try {
        await flowProcessor(ctx, flow, flowId);
        return true;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'unknown error';
        logger.error(err, `[FlowHandler] Error in flow: ${flow.flow}`);
        await ctx.reply(t(ctx.language, 'flow.error', { msg: errMsg }) || `An error occurred processing your flow step:\n${errMsg}`);
        return true;
      }
    }

    this.clearSession(ctx.senderId, flowId, ctx.platform);
    logger.warn(
      { flow: flow.flow, senderId: ctx.senderId, platform: ctx.platform },
      '[FlowHandler] No processor registered for active flow; session cleared',
    );
    await ctx.reply(t(ctx.language, 'flow.stale_cleared') || 'Previous process was interrupted. You can start a new request.');
    return false;
  }
}
