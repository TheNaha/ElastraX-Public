import { MessageContext } from './MessageContext';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { t } from '../utils/i18n';
import { CANCEL_COMMANDS } from './constants';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { flowSessions } from '../db/schema';

type SessionValue = string | number | boolean | null | SessionValue[] | { [key: string]: SessionValue };
type SessionData = Record<string, SessionValue>;

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
  private static dbLoaded = false;

  static register(flowName: string, processor: FlowProcessor) {
    this.flows[flowName] = processor;
    logger.debug({ flowName }, '[FlowHandler] Registered flow processor');
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
    try {
      // Lazy cleanup of all expired flows in DB at startup
      const rows = await db.select().from(flowSessions).all();
      const now = Date.now();
      const expiredIds: string[] = [];

      for (const row of rows) {
        try {
          const session = JSON.parse(row.data) as UserSession;
          const hasExpired = this.pruneExpiredFlows(session, now);

          if (hasExpired && !this.hasFlows(session.flows)) {
            expiredIds.push(row.id);
          } else if (hasExpired) {
            const data = JSON.stringify(session);
            await db.update(flowSessions).set({ data, updated_at: new Date() }).where(eq(flowSessions.id, row.id)).run();
          }
        } catch {
          expiredIds.push(row.id);
        }
      }

      if (expiredIds.length > 0) {
        await db.delete(flowSessions).where(inArray(flowSessions.id, expiredIds)).run();
      }

      this.dbLoaded = true;
      logger.debug({ expiredPruned: expiredIds.length }, '[FlowHandler] Initialized and pruned sessions');
    } catch (err) {
      logger.warn({ err }, '[FlowHandler] Failed to initialize from DB (non-fatal)');
    }
  }

  private static async _setSession(userId: string, flowId: string, flowData: Omit<FlowSession, 'expiresAt'>, platform: string, ttlSeconds: number) {
    const key = `${platform}:${userId}`;
    const rows = await db.select().from(flowSessions).where(eq(flowSessions.id, key));
    const session: UserSession = rows.length > 0 ? JSON.parse(rows[0].data) as UserSession : { activeFlow: null, flows: {} };
    
    session.flows[flowId] = {
      ...flowData,
      expiresAt: Date.now() + (ttlSeconds * 1000)
    };
    session.activeFlow = flowId;
    
    this.pruneExpiredFlows(session);
    
    const data = JSON.stringify(session);
    await db.insert(flowSessions)
      .values({ id: key, data, updated_at: new Date() })
      .onConflictDoUpdate({
        target: flowSessions.id,
        set: { data, updated_at: new Date() },
      })
      .run();
    logger.debug({ userId, flowId }, '[FlowHandler] Flow session updated');
  }

  static setSession(userId: string, flowId: string, flowData: Omit<FlowSession, 'expiresAt'>, platform: string = 'whatsapp', ttlSeconds: number = 300) {
    this._setSession(userId, flowId, flowData, platform, ttlSeconds).catch(err => {
      logger.error({ err, userId, flowId }, '[FlowHandler] Failed to set session asynchronously');
    });
  }

  private static async _getSession(userId: string, platform: string): Promise<UserSession | null> {
    const key = `${platform}:${userId}`;
    const rows = await db.select().from(flowSessions).where(eq(flowSessions.id, key));
    if (rows.length === 0) return null;
    
    try {
      const session = JSON.parse(rows[0].data) as UserSession;
      const hasExpired = this.pruneExpiredFlows(session);

      if (hasExpired && !this.hasFlows(session.flows)) {
        await db.delete(flowSessions).where(eq(flowSessions.id, key)).run();
        return null;
      }

      if (hasExpired) {
        const data = JSON.stringify(session);
        await db.update(flowSessions).set({ data, updated_at: new Date() }).where(eq(flowSessions.id, key)).run();
      }

      return session;
    } catch {
      await db.delete(flowSessions).where(eq(flowSessions.id, key)).run();
      return null;
    }
  }

  /**
   * Legacy synchronous getSession — DEPRECATED.
   *
   * The synchronous return contract cannot return a DB-backed session.
   * Use `getActiveFlow()` (async) instead. This method throws to fail fast
   * so any code accidentally calling it gets a clear error rather than a
   * silent `null` that causes downstream logic to be skipped.
   *
   * @deprecated Use `FlowHandler.getActiveFlow(userId, platform)` instead.
   * @throws {Error} Always — forces callers to migrate to the async API.
   */
  static getSession(_userId: string, _platform: string = 'whatsapp'): UserSession | null {
    throw new Error(
      '[FlowHandler.getSession is deprecated] Use async FlowHandler.getActiveFlow(userId, platform) instead.'
    );
  }

  static async getActiveFlow(userId: string, platform: string = 'whatsapp'): Promise<ActiveFlowEntry | null> {
    const session = await this._getSession(userId, platform);
    if (!session) return null;

    if (!session.activeFlow || !session.flows[session.activeFlow]) {
      this.selectFallbackActiveFlow(session);

      if (!session.activeFlow || !session.flows[session.activeFlow]) {
        return null;
      }

      const key = `${platform}:${userId}`;
      const data = JSON.stringify(session);
      await db.update(flowSessions).set({ data, updated_at: new Date() }).where(eq(flowSessions.id, key)).run();
    }

    return {
      flowId: session.activeFlow,
      flow: session.flows[session.activeFlow],
    };
  }

  private static async _clearSession(userId: string, flowId: string, platform: string) {
    const key = `${platform}:${userId}`;
    const session = await this._getSession(userId, platform);
    
    if (session && session.flows[flowId]) {
      delete session.flows[flowId];
      if (session.activeFlow === flowId) {
         this.selectFallbackActiveFlow(session);
      }
      
      if (!this.hasFlows(session.flows)) {
        await db.delete(flowSessions).where(eq(flowSessions.id, key)).run();
      } else {
        const data = JSON.stringify(session);
        await db.update(flowSessions).set({ data, updated_at: new Date() }).where(eq(flowSessions.id, key)).run();
      }
      logger.debug({ userId, flowId }, '[FlowHandler] Flow session cleared');
    }
  }

  static clearSession(userId: string, flowId: string, platform: string = 'whatsapp') {
    this._clearSession(userId, flowId, platform).catch(err => {
      logger.error({ err, userId, flowId }, '[FlowHandler] Failed to clear session asynchronously');
    });
  }

  static async handle(ctx: MessageContext): Promise<boolean> {
    const activeFlow = await this.getActiveFlow(ctx.senderId, ctx.platform);

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
        const errMsg = getErrorMessage(err, 'unknown error');
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
