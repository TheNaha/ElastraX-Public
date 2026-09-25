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
  roomId?: string;
  platform?: string;
  version?: number;
}

export interface UserSession {
  activeFlow: string | null;
  flows: Record<string, FlowSession>;
  version?: number;
  roomId?: string;
  platform?: string;
}

export interface ActiveFlowEntry {
  flowId: string;
  flow: FlowSession;
}

export type FlowProcessor = (ctx: MessageContext, activeFlowData: FlowSession, flowId: string) => Promise<void>;

type SessionLock = Promise<void>;

export class FlowVersionConflictError extends Error {
  readonly expected: number | undefined;
  readonly actual: number | undefined;

  constructor(expected: number | undefined, actual: number | undefined) {
    super('Flow session was modified by another worker');
    this.name = 'FlowVersionConflictError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class FlowHandler {
  private static flows: Record<string, FlowProcessor> = {};
  private static dbLoaded = false;
  private static initPromise: Promise<void> | null = null;
  private static locks = new Map<string, SessionLock>();
  private static memorySessions = new Map<string, UserSession>();

  static resetForTesting(): void {
    this.dbLoaded = false;
    this.initPromise = null;
    this.memorySessions.clear();
    this.locks.clear();
  }

  static register(flowName: string, processor: FlowProcessor): void {
    if (!flowName || typeof processor !== 'function') return;
    this.flows[flowName] = processor;
    logger.debug({ flowName }, '[FlowHandler] Registered flow processor');
  }

  private static hasFlows(flows: Record<string, FlowSession>): boolean {
    return Object.keys(flows).length > 0;
  }

  private static selectFallbackActiveFlow(session: UserSession): void {
    if (session.activeFlow && session.flows[session.activeFlow]) return;
    const last = Object.keys(session.flows).at(-1);
    session.activeFlow = last ?? null;
  }

  private static pruneExpiredFlows(session: UserSession, now = Date.now()): boolean {
    let changed = false;
    for (const [flowId, flow] of Object.entries(session.flows)) {
      if (!flow || !Number.isFinite(flow.expiresAt) || now > flow.expiresAt) {
        delete session.flows[flowId];
        if (session.activeFlow === flowId) session.activeFlow = null;
        changed = true;
      }
    }
    this.selectFallbackActiveFlow(session);
    return changed;
  }

  static initialize(): Promise<void> {
    if (this.dbLoaded) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initializeInternal().finally(() => {
      this.dbLoaded = true;
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private static async initializeInternal(): Promise<void> {
    try {
      const query = db.select().from(flowSessions) as unknown as { all?: () => Promise<typeof flowSessions.$inferSelect[]> } & PromiseLike<typeof flowSessions.$inferSelect[]>;
      const rawRows = typeof query.all === 'function' ? await query.all() : await query;
      const rows = Array.isArray(rawRows) ? rawRows : [];
      const now = Date.now();
      const expiredIds: string[] = [];
      for (const row of rows) {
        try {
          const session = JSON.parse(row.data) as UserSession;
          if (!session || typeof session !== 'object' || !session.flows || typeof session.flows !== 'object' || Array.isArray(session.flows)) throw new Error('invalid flow session');
          const changed = this.pruneExpiredFlows(session, now);
          if (changed && !this.hasFlows(session.flows)) {
            expiredIds.push(row.id);
          } else if (changed) {
            await db.update(flowSessions).set({ data: JSON.stringify(session), updated_at: new Date() }).where(eq(flowSessions.id, row.id)).run();
          }
        } catch {
          expiredIds.push(row.id);
        }
      }
      if (expiredIds.length > 0) await db.delete(flowSessions).where(inArray(flowSessions.id, expiredIds)).run();
      logger.debug({ expiredPruned: expiredIds.length }, '[FlowHandler] Initialized and pruned sessions');
    } catch (error: unknown) {
      logger.warn({ err: error }, '[FlowHandler] Failed to initialize from DB (non-fatal)');
    }
  }

  private static sessionKey(userId: string, platform: string, roomId?: string): string {
    return `${platform}:${roomId ?? '*'}:${userId}`;
  }

  private static async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.locks.set(key, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }

  private static async readSession(key: string): Promise<UserSession | null> {
    try {
      const rows = await db.select().from(flowSessions).where(eq(flowSessions.id, key));
      const list = Array.isArray(rows) ? rows : [];
      if (list.length === 0) return this.memorySessions.get(key) ?? null;
      try {
        const session = JSON.parse(list[0].data) as UserSession;
        if (!session || typeof session !== 'object' || !session.flows || typeof session.flows !== 'object' || Array.isArray(session.flows)) throw new Error('invalid flow session');
        this.memorySessions.set(key, session);
        return session;
      } catch {
        await db.delete(flowSessions).where(eq(flowSessions.id, key)).run();
        return null;
      }
    } catch (error: unknown) {
      logger.warn({ err: error, key }, '[FlowHandler] Session read failed; using process-local fallback');
      return this.memorySessions.get(key) ?? null;
    }
  }

  private static async writeSession(key: string, session: UserSession): Promise<void> {
    session.version = (session.version ?? 0) + 1;
    for (const flow of Object.values(session.flows)) flow.version = session.version;
    this.memorySessions.set(key, session);
    const serialized = JSON.stringify(session);
    try {
    const builder = (db.insert(flowSessions) as unknown as {
      values: (values: unknown) => {
        onConflictDoUpdate?: (options: unknown) => { run?: () => Promise<unknown> } | Promise<unknown>;
        run?: () => Promise<unknown>;
        then?: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise<unknown>;
        onConflictDoNothing?: () => Promise<unknown>;
      };
    }).values({ id: key, data: serialized, updated_at: new Date() });
    const upsert = builder.onConflictDoUpdate;
    if (typeof upsert === 'function') {
      const result = upsert.call(builder, { target: flowSessions.id, set: { data: serialized, updated_at: new Date() } });
      if (result && typeof (result as { run?: unknown }).run === 'function') await (result as { run: () => Promise<unknown> }).run();
      else await result;
      return;
    }
    if (typeof builder.run === 'function') {
      await builder.run();
      return;
    }
    if (typeof builder.then === 'function') {
      await (builder as unknown as PromiseLike<unknown>);
      return;
    }
    if (typeof builder.onConflictDoNothing === 'function') await builder.onConflictDoNothing();
    } catch (error: unknown) {
      logger.warn({ err: error, key }, '[FlowHandler] Session persistence failed; retaining process-local session');
    }
  }

  private static async setSessionInternal(userId: string, flowId: string, flowData: Omit<FlowSession, 'expiresAt'>, platform: string, ttlSeconds: number, roomId?: string, expectedVersion?: number): Promise<void> {
    if (!userId?.trim() || !flowId?.trim() || !platform?.trim()) throw new Error('Flow session identity is required.');
    await this.initialize();
    const key = this.sessionKey(userId, platform, roomId);
    return this.withLock(key, async () => {
      const existing = await this.readSession(key);
      if (expectedVersion !== undefined && (existing?.version ?? 0) !== expectedVersion) throw new FlowVersionConflictError(expectedVersion, existing?.version);
      const session: UserSession = existing ?? { activeFlow: null, flows: {}, version: 0 };
      const boundRoom = [roomId, flowData.roomId, typeof flowData.data.chatId === 'string' ? flowData.data.chatId : undefined]
        .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
      const ttl = Number.isFinite(ttlSeconds) ? Math.min(Math.max(1, ttlSeconds), 86_400) : 300;
      const next: FlowSession = {
        ...flowData,
        roomId: boundRoom,
        platform,
        expiresAt: Date.now() + ttl * 1000,
      };
      session.flows[flowId] = next;
      session.activeFlow = flowId;
      session.roomId = boundRoom ?? session.roomId;
      session.platform = platform;
      this.pruneExpiredFlows(session);
      await this.writeSession(key, session);
      logger.debug({ userId, flowId, roomId: boundRoom }, '[FlowHandler] Flow session updated');
    });
  }

  static setSession(userId: string, flowId: string, flowData: Omit<FlowSession, 'expiresAt'>, platform = 'whatsapp', ttlSeconds = 300, roomId?: string, expectedVersion?: number): Promise<void> {
    return this.setSessionInternal(userId, flowId, flowData, platform, ttlSeconds, roomId, expectedVersion);
  }

  private static async getSessionInternal(userId: string, platform: string, roomId?: string): Promise<UserSession | null> {
    await this.initialize();
    const key = this.sessionKey(userId, platform, roomId);
    let session = await this.readSession(key);
    if (!session && roomId) session = await this.readSession(this.sessionKey(userId, platform));
    if (!session) return null;
    if (roomId && session.roomId && session.roomId !== roomId) return null;
    const changed = this.pruneExpiredFlows(session);
    if (changed) {
      if (!this.hasFlows(session.flows)) {
        this.memorySessions.delete(key);
        try { await db.delete(flowSessions).where(eq(flowSessions.id, key)).run(); } catch (error: unknown) { logger.warn({ err: error, key }, '[FlowHandler] Expired session deletion failed'); }
        return null;
      }
      await this.writeSession(key, session);
    }
    return session;
  }

  static hydrate(): Promise<void> {
    return this.initialize();
  }

  static getSessionAsync(userId: string, platform = 'whatsapp', roomId?: string): Promise<UserSession | null> {
    return this.getSessionInternal(userId, platform, roomId);
  }

  static getSession(_userId: string, _platform = 'whatsapp'): UserSession | null {
    throw new Error('[FlowHandler.getSession is deprecated] Use async FlowHandler.getActiveFlow(userId, platform) instead.');
  }

  static async getActiveFlow(userId: string, platform = 'whatsapp', roomId?: string): Promise<ActiveFlowEntry | null> {
    const session = await this.getSessionInternal(userId, platform, roomId);
    if (!session) return null;
    this.selectFallbackActiveFlow(session);
    if (!session.activeFlow || !session.flows[session.activeFlow]) return null;
    const flow = session.flows[session.activeFlow];
    if (flow.platform && flow.platform !== platform) return null;
    if (roomId && flow.roomId && flow.roomId !== roomId) return null;
    if (roomId && !flow.roomId && typeof flow.data.chatId === 'string' && flow.data.chatId !== roomId) return null;
    return { flowId: session.activeFlow, flow };
  }

  private static async clearSessionInternal(userId: string, flowId: string, platform: string, roomId?: string, expectedVersion?: number): Promise<void> {
    if (!userId?.trim() || !flowId?.trim() || !platform?.trim()) return;
    await this.initialize();
    const key = this.sessionKey(userId, platform, roomId);
    await this.withLock(key, async () => {
      let session = await this.readSession(key);
      let storageKey = key;
      if (!session && roomId) {
        storageKey = this.sessionKey(userId, platform);
        session = await this.readSession(storageKey);
      }
      if (!session || !session.flows[flowId]) return;
      if (expectedVersion !== undefined && (session.version ?? 0) !== expectedVersion) throw new FlowVersionConflictError(expectedVersion, session.version);
      delete session.flows[flowId];
      if (session.activeFlow === flowId) this.selectFallbackActiveFlow(session);
      if (!this.hasFlows(session.flows)) {
        this.memorySessions.delete(storageKey);
        try { await db.delete(flowSessions).where(eq(flowSessions.id, storageKey)).run(); } catch (error: unknown) { logger.warn({ err: error, key: storageKey }, '[FlowHandler] Session deletion failed; cleared process-local session'); }
      } else await this.writeSession(storageKey, session);
      logger.debug({ userId, flowId }, '[FlowHandler] Flow session cleared');
    });
  }

  static clearSession(
    userId: string,
    flowId: string,
    platform = 'whatsapp',
    roomIdOrVersion?: string | number,
    expectedVersion?: number,
  ): Promise<void> {
    const roomId = typeof roomIdOrVersion === 'string' ? roomIdOrVersion : undefined;
    const version = typeof roomIdOrVersion === 'number' ? roomIdOrVersion : expectedVersion;
    return this.clearSessionInternal(userId, flowId, platform, roomId, version);
  }

  private static flowBelongsToContext(flow: FlowSession, ctx: MessageContext): boolean {
    if (flow.platform && flow.platform !== ctx.platform) return false;
    if (flow.roomId && flow.roomId !== ctx.chatId) return false;
    const legacyRoom = typeof flow.data.chatId === 'string' ? flow.data.chatId : undefined;
    if (legacyRoom && legacyRoom !== ctx.chatId) return false;
    if (!flow.roomId && ctx.isGroup) return false;
    return true;
  }

  static async handle(ctx: MessageContext): Promise<boolean> {
    const activeFlow = await this.getActiveFlow(ctx.senderId, ctx.platform, ctx.chatId);
    if (!activeFlow) return false;
    const { flowId, flow } = activeFlow;
    if (!this.flowBelongsToContext(flow, ctx)) {
      await this.clearSession(ctx.senderId, flowId, ctx.platform, ctx.chatId);
      await ctx.reply(t(ctx.language, 'flow.stale_cleared') || 'Previous process was interrupted. You can start a new request.');
      return true;
    }
    const flowProcessor = this.flows[flow.flow];
    if (!flowProcessor) {
      await this.clearSession(ctx.senderId, flowId, ctx.platform, ctx.chatId);
      logger.warn({ flow: flow.flow, senderId: ctx.senderId, platform: ctx.platform }, '[FlowHandler] No processor registered for active flow; session cleared');
      await ctx.reply(t(ctx.language, 'flow.stale_cleared') || 'Previous process was interrupted. You can start a new request.');
      return false;
    }
    const normalized = ctx.text.trim().toLowerCase();
    if (normalized.startsWith('/')) {
      if (CANCEL_COMMANDS.some((command) => command.toLowerCase() === normalized)) {
        await this.clearSession(ctx.senderId, flowId, ctx.platform, ctx.chatId);
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
    } catch (error: unknown) {
      const message = getErrorMessage(error, 'unknown error');
      logger.error({ err: error, flow: flow.flow }, `[FlowHandler] Error in flow: ${flow.flow}`);
      await ctx.reply(t(ctx.language, 'flow.error', { msg: message }) || `An error occurred processing your flow step:\n${message}`);
      return true;
    }
  }
}
