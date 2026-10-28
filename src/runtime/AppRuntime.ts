import { handleIncomingMessage } from '../agent';
import { MessageContext } from '../core/MessageContext';
import { BotProvider } from '../providers/BotProvider';
import { DiscordProvider } from '../providers/discord';
import { TelegramProvider } from '../providers/telegram';
import { createAdminHandler } from '../admin/routes';
import { WhatsAppProvider } from '../providers/whatsapp';
import { MessageQueue, type MessageQueueStats } from '../utils/MessageQueue';
import { MediaCleanup } from '../utils/MediaCleanup';
import { RateLimiter } from '../utils/RateLimiter';
import { Scheduler, type ScheduledTaskFn } from '../utils/Scheduler';
import {
  readScheduledTaskPolicy,
  createTaskBudget,
  consumeTaskBudget,
  describePolicy,
  logRefusal as logTaskRefusal,
} from '../utils/scheduledTasks';
import { DigestService } from '../utils/DigestService';
import { healthMetrics } from '../utils/HealthMetrics';
import { logger } from '../utils/logger';
import { WebhookServer } from '../webhookServer';
import { healthMonitor, type HealthMonitor } from '../utils/HealthMonitor';
import { getMediaCleanupIntervalMs, getQueueConfig } from '../config/runtime';
import { registryReady, mutatingToolNames } from '../tools';
import { safeRegisterFlows } from '../flows/registry';
import { isSchemaReady, sqlite } from '../db';
import { runRetentionMaintenance } from '../db/maintenance';
import { InboxService } from '../messaging/InboxService';
import { OutboxService } from '../messaging/OutboxService';
import { platformsForRemoteRoomId, providerRoomTargetMismatch, resolveCanonicalRoomKey } from '../messaging/roomKeys';
import { inferPlatformFromRoomId } from '../core/platforms';
import { roleSatisfies } from '../core/roleAccess';
import type {
  WebhookEnqueuer,
  WebhookReadinessCheck,
} from '../webhooks/types';
import { withCancellableTimeout } from '../utils/withTimeout.js';
import { randomUUID, createHash } from 'node:crypto';

type SenderFn = (chatId: string, text: string, signal?: AbortSignal) => Promise<void>;

type SenderRegistry = {
  registerSender(platform: string, send: SenderFn): void | (() => void);
  start(): void;
  stop(): void;
  registerReadinessCheck?(check: WebhookReadinessCheck): () => void;
  registerEnqueuer?(enqueuer: WebhookEnqueuer): () => void;
  unregisterSender?(platform: string): void;
  /**
   * Present when the scheduler can execute agent tasks, not just send text.
   * `null` clears the runner, which `stop()` must do: the scheduler is a
   * process-global singleton, so a stop/start cycle in one process would
   * otherwise keep the previous runtime's handler (and its message handler,
   * operational providers and budget) installed.
   */
  registerTaskRunner?(fn: ScheduledTaskFn | null): void;
  /** Optional so existing test doubles keep satisfying this structural type. */
  registerAdminHandler?(handler: (req: Request, ip: string, server: unknown) => Promise<Response> | Response): void;
};

type QueueController = {
  enqueue(roomId: string, task: (signal?: AbortSignal) => Promise<void>): unknown;
  stop(): void;
  closeAndDrain?(graceMs?: number): Promise<void>;
  getStats?(): Partial<MessageQueueStats>;
};

type TimerApi = {
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
};

/**
 * The only role an unattended run may hold. The scheduler is not a person, so
 * it gets the baseline role and nothing else: every privilege-gated tool
 * refuses, and an instruction that happens to look like a slash command cannot
 * reach a mutating command.
 */
const SCHEDULED_TASK_ROLES: readonly string[] = ['user'];

/** Raised when a scheduled run reaches for a capability it must not have. */
export class ScheduledTaskCapabilityError extends Error {
  readonly capability: string;

  constructor(capability: string) {
    super(`A scheduled agent task may not use "${capability}"; it runs without a human present.`);
    this.name = 'ScheduledTaskCapabilityError';
    this.capability = capability;
  }
}

/** Same ownership rule the registry applies: `owner` satisfies every level. */
function hasRequiredRoleFor(roles: readonly string[], required: string): boolean {
  return roleSatisfies(roles, required);
}

/**
 * Human-readable reason a provider is not operational. Prefers the provider's own
 * `lastError` (set on login failure, shard error and unrecoverable close) and
 * falls back to the status so a not-yet-connected provider is still explained.
 *
 * `/ready` is unauthenticated, so the message is redacted and truncated before it
 * leaves the process: a provider error is free-form text and a third-party client
 * library can embed a credential in it. A readiness body must never be the place
 * a secret leaks.
 */
function describeProviderState(provider: BotProvider): string {
  const status = provider.status ?? 'unknown';
  const message = provider.lastError?.message?.trim();
  if (!message) return status;
  return `${status}: ${redactSecrets(message).slice(0, 200)}`;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  // `key=value` / `key: value` for anything that smells like a credential.
  /\b(token|api[_-]?key|secret|password|authorization|bearer)\b(\s*[:=]\s*)\S+/gi,
  // Bare JWTs.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

/** Replace anything credential-shaped with a marker. */
export function redactSecrets(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, label: string | undefined, separator: string | undefined) =>
      label !== undefined ? `${label}${separator ?? '='}[redacted]` : '[redacted]',
    );
  }
  return output;
}

/**
 * Stable, non-placeholder id for a synthetic scheduled run.
 *
 * The message-id dedupe index deliberately excludes placeholder ids, and an
 * empty or `'unknown'` id made every stored run look like the *current* message,
 * which re-embedded up to `INLINE_MEDIA_MAX_BYTES` of history per turn.
 */
/** Field separator for hashed composite keys, matching `OutboxService.idempotencyKey`. */
const FIELD_SEPARATOR = '\u0000';

function scheduledTaskMessageId(request: {
  platform: string;
  roomKey: string;
  instruction: string;
  receivedAt?: number;
}): string {
  const digest = createHash('sha256')
    .update(`${request.platform}${FIELD_SEPARATOR}${request.roomKey}${FIELD_SEPARATOR}${request.instruction}`)
    .digest('hex')
    .slice(0, 24);
  return `scheduled-${digest}`;
}

export type AppRuntimeDeps = {
  providers?: BotProvider[];
  messageQueue?: QueueController;
  webhookServer?: SenderRegistry;
  scheduler?: SenderRegistry;
  digestService?: SenderRegistry;
  handleIncomingMessage?: (ctx: MessageContext) => Promise<void>;
  rateLimiter?: Pick<typeof RateLimiter, 'prune'>;
  mediaCleanup?: Pick<typeof MediaCleanup, 'pruneOldFiles'>;
  timers?: TimerApi;
  runStartupCoverageScan?: () => Promise<void>;
  startupCoverageDelayMs?: number;
  healthMonitor?: HealthMonitor;
};

export function resolveMediaCleanupIntervalMs(rawMediaCleanupInterval: string | undefined): number {
  return getMediaCleanupIntervalMs({ MEDIA_CLEANUP_INTERVAL_MS: rawMediaCleanupInterval });
}

function hasDurableMessagingStore(): boolean {
  const candidate = sqlite as unknown as { query?: unknown };
  return typeof candidate.query === 'function';
}

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test';
}

export class AppRuntime {
  private readonly providers: BotProvider[];
  private readonly messageQueue: QueueController;
  private readonly webhookServer: SenderRegistry;
  private readonly scheduler: SenderRegistry;
  private readonly digestService: SenderRegistry;
  private readonly messageHandler: (ctx: MessageContext) => Promise<void>;
  private readonly rateLimiter: Pick<typeof RateLimiter, 'prune'>;
  private readonly mediaCleanup: Pick<typeof MediaCleanup, 'pruneOldFiles'>;
  private readonly timers: TimerApi;
  private readonly runStartupCoverageScan?: () => Promise<void>;
  private readonly startupCoverageDelayMs: number;
  private readonly healthMon: HealthMonitor;

  private readonly inboxOwner = `runtime:${process.pid}:${randomUUID()}`;
  private readonly outboxOwner = `runtime:${process.pid}:${randomUUID()}`;
  private rateLimiterTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private outboxTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private outboxPromise: Promise<void> | null = null;
  private mediaCleanupTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private retentionTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private startupCoverageTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private mediaCleanupPromise: Promise<void> | null = null;
  private retentionPromise: Promise<void> | null = null;
  private activeProviders: BotProvider[] = [];
  private unregisterWebhookHooks: Array<() => void> = [];
  private unregisterSenderHooks: Array<() => void> = [];
  private started = false;
  private stopping = false;
  /**
   * Set the moment a shutdown is requested, including while `start()` is still
   * awaiting provider connections. `stop()` used to return immediately when
   * `started` was still false, so a SIGTERM during boot was dropped on the floor:
   * `start()` then ran to completion with the database already closed, binding
   * the HTTP listener and connecting both providers. `start()` checks this flag
   * at every await boundary and unwinds instead.
   */
  private stopRequested = false;

  constructor(deps: AppRuntimeDeps = {}) {
    // Telegram is always constructed but reports `not_configured` without a
    // token, so an operator sees the gap in readiness instead of a boot failure.
    this.providers = deps.providers ?? [new WhatsAppProvider(), new DiscordProvider(), new TelegramProvider()];
    this.messageQueue = deps.messageQueue ?? new MessageQueue(1, 5 * 60 * 1000, getQueueConfig());
    this.webhookServer = deps.webhookServer ?? new WebhookServer();
    this.scheduler = deps.scheduler ?? Scheduler;
    this.digestService = deps.digestService ?? DigestService;
    this.messageHandler = deps.handleIncomingMessage ?? handleIncomingMessage;
    this.rateLimiter = deps.rateLimiter ?? RateLimiter;
    this.mediaCleanup = deps.mediaCleanup ?? MediaCleanup;
    this.timers = deps.timers ?? globalThis;
    this.runStartupCoverageScan = deps.runStartupCoverageScan;
    this.startupCoverageDelayMs = deps.startupCoverageDelayMs ?? 5000;
    this.healthMon = deps.healthMonitor ?? healthMonitor;

    const getStats = this.messageQueue.getStats?.bind(this.messageQueue);
    if (getStats) {
      healthMetrics.registerQueueStats(() => ({
        totalRooms: 0,
        totalPending: 0,
        totalRunning: 0,
        oldestPendingAgeMs: 0,
        droppedTasks: 0,
        stopped: false,
        ...getStats(),
      }));
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.stopRequested = false;

    // Wait for the tool registry (core tools + plugins) before accepting messages,
    // so slash commands and LLM tool lookups never hit an empty registry.
    await registryReady;

    // Register all flow processors in a centralized location.
    await safeRegisterFlows();
    if (this.stopRequested) {
      logger.info('Startup interrupted before providers were started');
      return;
    }

    const queuedHandler = async (ctx: MessageContext): Promise<void> => {
      // Canonical room key first: every durable row filed for this message is
      // keyed on it, while providers keep using the raw ctx.chatId.
      const roomKey = this.attachRoomKey(ctx);
      if (!hasDurableMessagingStore()) {
        this.messageQueue.enqueue(roomKey, async signal => {
          signal?.throwIfAborted();
          if (!ctx.signal && signal) Object.defineProperty(ctx, 'signal', { value: signal, configurable: true });
          await this.messageHandler(ctx);
        });
        return;
      }
      let admission: ReturnType<typeof InboxService.admit>;
      try {
        admission = InboxService.admit(ctx);
      } catch (error) {
        if (!isTestRuntime()) throw error;
        this.messageQueue.enqueue(roomKey, async signal => {
          signal?.throwIfAborted();
          if (!ctx.signal && signal) Object.defineProperty(ctx, 'signal', { value: signal, configurable: true });
          await this.messageHandler(ctx);
        });
        return;
      }
      if (!admission.accepted) {
        logger.info({ chatId: ctx.chatId, roomKey, platform: ctx.platform, reason: admission.reason }, 'Provider event already completed');
        return;
      }
      const task = async (signal?: AbortSignal): Promise<void> => {
        signal?.throwIfAborted();
        if (!ctx.signal && signal) {
          Object.defineProperty(ctx, 'signal', { value: signal, configurable: true });
        }
        if (!InboxService.claim(admission.id, this.inboxOwner)) return;
        try {
          await this.messageHandler(ctx);
          InboxService.complete(admission.id, this.inboxOwner);
        } catch (error) {
          InboxService.fail(admission.id, this.inboxOwner, error);
          throw error;
        }
      };

      let accepted = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        accepted = this.messageQueue.enqueue(roomKey, task) !== false;
        if (accepted) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!accepted) {
        InboxService.deferUnclaimed(admission.id, new Error('Message queue remained at capacity'));
        logger.warn({ chatId: ctx.chatId, roomKey, platform: ctx.platform }, 'Message rejected after queue backpressure timeout');
      }
    };

    for (const provider of this.providers) {
      provider.onMessage(queuedHandler);
    }

    const results = await Promise.allSettled(this.providers.map(provider => provider.start()));
    if (this.stopRequested) {
      // A shutdown landed while the providers were connecting. Unwind what came
      // up instead of continuing to bind the HTTP listener against a database
      // the shutdown path has already closed.
      logger.info('Startup interrupted while providers were connecting; unwinding');
      this.started = true;
      await this.teardown();
      this.started = false;
      return;
    }
    // Admission is deliberately based on `start()` resolving, NOT on
    // `isOperational`. A provider that connects asynchronously (WhatsApp only
    // reports 'running' from its `connection.update` 'open' handler, which fires
    // after the socket is created) is legitimately not operational at this
    // instant. Freezing the set on `isOperational` here used to drop WhatsApp
    // from the sender registry on every boot, leaving webhook and outbox
    // delivery with no WhatsApp lane at all.
    this.activeProviders = results.flatMap((result, index) => {
      const provider = this.providers[index]!;
      if (result.status === 'fulfilled') {
        if (provider.isOperational === false) {
          logger.info(
            { provider: provider.name, status: provider.status },
            'Provider started but is not operational yet; it will be used once it connects',
          );
        }
        return [provider];
      }
      logger.error({ err: result.reason, provider: provider.name }, 'Provider failed to start; continuing in degraded mode');
      return [];
    });

    if (this.operationalProviders().length === 0) {
      logger.error('No messaging provider is ready');
    }

    this.started = true;
    try {
      this.registerAdminDashboard();
      this.registerProviderSenders();
      this.registerScheduledTasks();
      const unregisterReadiness = this.webhookServer.registerReadinessCheck?.(() => {
        const readiness = this.getReadiness();
        const notReady: Record<string, string> = {};
        if (!readiness.checks.database) notReady.database = 'schema not ready';
        if (!readiness.checks.queue) notReady.queue = 'message queue stopped';
        for (const [name, up] of Object.entries(readiness.checks.providers)) {
          if (!up) notReady[`provider:${name}`] = readiness.providerErrors[name] ?? 'not operational';
        }
        return { ready: readiness.ready, details: notReady };
      });

      if (unregisterReadiness) this.unregisterWebhookHooks.push(unregisterReadiness);
      const unregisterEnqueuer = this.webhookServer.registerEnqueuer?.(this.enqueueWebhook);
      if (unregisterEnqueuer) this.unregisterWebhookHooks.push(unregisterEnqueuer);
      if (this.stopRequested) return;
      await Promise.resolve(this.webhookServer.start());
      if (this.stopRequested) return;
      await Promise.resolve(this.scheduler.start());
      if (this.stopRequested) return;
      await Promise.resolve(this.digestService.start());
      if (this.stopRequested) return;
      this.healthMon.start();
      this.startBackgroundTasks();
    } catch (err) {
      await this.stop();
      throw err;
    }

    logger.info({ readyProviders: this.activeProviders.map(provider => provider.name) }, 'Bot is running');
  }

  /**
   * Providers that are started AND currently able to accept an outbound send.
   * `activeProviders` is the set whose `start()` resolved; a provider inside it
   * may still be reconnecting, so delivery decisions consult this subset instead
   * of the boot-time snapshot. Evaluating it lazily (rather than once at boot)
   * is what lets a provider that connects late still receive traffic.
   */
  private operationalProviders(): BotProvider[] {
    return this.activeProviders.filter(provider => provider.isOperational !== false);
  }

  getReadiness(): {
    ready: boolean;
    checks: { database: boolean; queue: boolean; providers: Record<string, boolean> };
    /**
     * Why a provider is not up. `BotProvider.lastError` was written by both
     * providers and read by nothing, so an operator polling /ready or /metrics
     * saw `discord: false` with no way to learn that the gateway closed on a
     * disallowed intent or the token was revoked.
     */
    providerErrors: Record<string, string>;
  } {
    const providers = Object.fromEntries(this.providers.map(provider => [provider.name, provider.isOperational !== false]));
    const providerErrors = Object.fromEntries(
      this.providers
        .filter(provider => provider.isOperational !== true)
        .map(provider => [provider.name, describeProviderState(provider)]),
    );
    const queueStats = this.messageQueue.getStats?.() ?? {};
    const databaseReady = isSchemaReady();
    const queueReady = queueStats.stopped !== true;
    return {
      providerErrors,
      ready: this.started && databaseReady && queueReady && Object.values(providers).some(Boolean),
      checks: { database: databaseReady, queue: queueReady, providers },
    };
  }

  async stop(): Promise<void> {
    // A shutdown requested before `start()` finished still has to take effect:
    // `start()` observes `stopRequested` at its await boundaries and unwinds.
    // Returning early here is what let a SIGTERM during boot be dropped, after
    // which `start()` bound the HTTP listener and connected both providers
    // against an already-closed database.
    this.stopRequested = true;
    if (this.stopping) return;
    if (!this.started) return;
    this.stopping = true;
    try {
      await this.teardown();
    } finally {
      this.activeProviders = [];
      this.started = false;
      this.stopping = false;
      logger.info('Graceful shutdown complete');
    }
  }

  /**
   * Release everything `start()` may have acquired. Safe to call at any point
   * after provider start-up, including from the error path in `start()` and
   * from a shutdown that landed mid-boot.
   */
  private async teardown(): Promise<void> {
    for (const unregister of [...this.unregisterWebhookHooks.splice(0), ...this.unregisterSenderHooks.splice(0)]) {
      try {
        unregister();
      } catch (error) {
        logger.warn({ err: error }, 'Webhook hook unregistration failed');
      }
    }

    // `registerTaskRunner` is process-global on Scheduler, so a stop/start cycle
    // in one process would otherwise leave the previous runtime's runner (and
    // its message handler and budget) installed.
    this.scheduler.registerTaskRunner?.(null);

    for (const provider of this.activeProviders) {
      this.scheduler.unregisterSender?.(provider.name);
      this.digestService.unregisterSender?.(provider.name);
    }
    try {
      await this.stopBackgroundTasks();
      this.digestService.stop();
      this.scheduler.stop();
      this.webhookServer.stop();
      this.healthMon.stop();
      if (this.messageQueue.closeAndDrain) {
        await this.messageQueue.closeAndDrain();
      } else {
        this.messageQueue.stop();
      }
      this.processOutbox();
      if (this.outboxPromise) await this.outboxPromise;

      await Promise.allSettled(this.providers.map(async provider => {
        await Promise.race([
          provider.stop(),
          new Promise<void>((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`Provider ${provider.name} stop timed out`)), 10_000);
            timer.unref?.();
          }),
        ]);
      }));
    } catch (error) {
      logger.error({ err: error }, 'Runtime teardown failed');
    }
  }

  /**
   * Determine the platform for a webhook destination that did not carry one.
   *
   * This deliberately refuses to guess. The previous fallback returned
   * `activeProviders[0]`, which made the target platform depend on provider
   * start order and produced a fabricated canonical room key that then sailed
   * past `providerRoomTargetMismatch` — the invalid id was handed straight to
   * the provider and only failed after the client had been told `202 queued`.
   *
   * The shape-based inference now comes from the shared helper in
   * `src/core/platforms.ts`, so this and the webhook room resolver agree. The
   * old local copy only knew WhatsApp and Discord, so a numeric Telegram chat
   * id was classified as Discord and the message was delivered to the wrong
   * platform.
   */
  private inferWebhookPlatform(chatRoomId: string): string {
    // Prefer an explicit registry hit: a numeric id that is already registered
    // on Telegram must not be mis-routed to Discord just because it is numeric.
    const registered = platformsForRemoteRoomId(chatRoomId);
    if (registered.length === 1) return registered[0]!;
    if (registered.length > 1) {
      throw new Error(
        `Cannot determine platform for webhook destination "${chatRoomId}"; it matches multiple platforms`,
      );
    }
    const platform = inferPlatformFromRoomId(chatRoomId);
    if (platform) return platform;
    throw new Error(
      `Cannot determine platform for webhook destination "${chatRoomId}"; it must be registered or carry an explicit platform`,
    );
  }

  /**
   * Resolve/attach the canonical room key on the context before any durable row
   * is written.  Provider I/O keeps using `ctx.chatId`.
   */
  private attachRoomKey(ctx: MessageContext): string {
    const existing = typeof ctx.roomKey === 'string' ? ctx.roomKey.trim() : '';
    if (existing) return existing;
    const roomKey = resolveCanonicalRoomKey(ctx.platform, ctx.chatId);
    try {
      ctx.roomKey = roomKey;
    } catch {
      try {
        Object.defineProperty(ctx, 'roomKey', { value: roomKey, configurable: true, writable: true });
      } catch (err) {
        logger.warn({ err }, 'Unable to attach canonical room key to message context');
      }
    }
    return roomKey;
  }

  private readonly enqueueWebhook: WebhookEnqueuer = async (job, signal) => {
    if (signal.aborted) throw signal.reason ?? new Error('Webhook enqueue aborted');
    if (job.destinations.length === 0) throw new Error('Webhook job has no destinations');
    // A `202` promises eventual delivery. If nothing is currently able to
    // deliver, say so instead of queueing rows no worker can claim — the
    // WebhookServer turns `accepted: false` into a retryable 503.
    //
    // The check is per destination *platform*, not just "is any provider up". A
    // job whose destinations are all Discord while Discord is in `error` and
    // WhatsApp is healthy used to be accepted: the outbox worker's claim query
    // filters on operational platforms, so the row sat `pending` forever with no
    // retry, no dead-letter and no metric — a silent, permanent loss behind a
    // successful 202.
    const deliverable = new Set<string>(this.operationalProviders().map(provider => provider.name));
    if (deliverable.size === 0) {
      logger.error({ route: job.route, destinations: job.destinations.length }, 'Rejecting webhook: no operational provider');
      return { accepted: false, deliveryId: '', acceptedAt: new Date().toISOString() };
    }
    const acceptedAt = new Date().toISOString();
    const eventKey = job.eventId ?? `${job.route}:${job.source}:${job.receivedAt}:${job.text}`;
    // Resolve and validate every destination first so a non-deliverable or
    // unclassifiable one cannot leave earlier rows enqueued behind a 503.
    const resolved: Array<{ destination: (typeof job.destinations)[number]; platform: string; roomKey: string }> = [];
    for (const destination of job.destinations) {
      let platform: string;
      try {
        platform = destination.platform ?? this.inferWebhookPlatform(destination.chatRoomId);
      } catch (error) {
        logger.error({ err: error, route: job.route, chatRoomId: destination.chatRoomId }, 'Rejecting webhook: cannot determine destination platform');
        return { accepted: false, deliveryId: '', acceptedAt };
      }
      if (!deliverable.has(platform)) {
        logger.error(
          { route: job.route, platform, providers: [...deliverable] },
          'Rejecting webhook: destination platform is not operational',
        );
        return { accepted: false, deliveryId: '', acceptedAt };
      }
      const roomKey = destination.roomKey?.trim() || resolveCanonicalRoomKey(platform, destination.chatRoomId);
      resolved.push({ destination, platform, roomKey });
    }
    const deliveryIds: string[] = [];
    for (const { destination, platform, roomKey } of resolved) {
      deliveryIds.push(OutboxService.enqueueText(
        platform,
        destination.chatRoomId,
        job.text,
        ['webhook', job.route, eventKey, destination.platform ?? '', destination.chatRoomId, roomKey],
        { roomKey },
      ));
    }
    if (signal.aborted) throw signal.reason ?? new Error('Webhook enqueue aborted');
    return {
      accepted: true,
      deliveryId: deliveryIds.join(','),
      acceptedAt,
    };
  };

  /**
   * Mount the admin dashboard on this port. Registered unconditionally so the
   * handler exists; it answers 404 for everything when no admin token is
   * configured, so the surface disappears rather than existing unauthenticated.
   */
  private registerAdminDashboard(): void {
    this.webhookServer.registerAdminHandler?.(createAdminHandler());
  }

  private registerProviderSenders(): void {
    for (const provider of this.activeProviders) {
      const send: SenderFn = async (chatId: string, text: string, signal?: AbortSignal) => {
        if (signal) await provider.sendMessage(chatId, text, signal);
        else await provider.sendMessage(chatId, text);
      };
      const unregister = this.webhookServer.registerSender(provider.name, send);
      if (unregister) this.unregisterSenderHooks.push(unregister);
      this.scheduler.registerSender(provider.name, send);
      this.digestService.registerSender(provider.name, send);
    }
  }

  /**
   * Wire scheduled agent runs.
   *
   * A reminder whose text starts with the agent-task marker is executed as a
   * model turn in its room instead of being delivered as text. The policy and
   * budget are enforced here, before any model call, so a misconfigured
   * recurrence cannot spend money unbounded.
   */
  private registerScheduledTasks(): void {
    const policy = readScheduledTaskPolicy(process.env);
    const budget = createTaskBudget();
    if (!policy.enabled || policy.allowedRooms.length === 0) {
      logger.info({ policy: describePolicy(policy) }, '[ScheduledTasks] Disabled');
      return;
    }
    if (!this.scheduler.registerTaskRunner) {
      logger.warn('[ScheduledTasks] Scheduler does not support task runs; ignoring configuration');
      return;
    }
    // The deny list is derived from the registry's own mutability table rather
    // than maintained by hand, so a tool that starts mutating state cannot slip
    // past the guard by simply not being named here. `policy.deniedTools` adds
    // the operator's own extra exclusions on top.
    const deniedTools = [...new Set([...mutatingToolNames(), ...policy.deniedTools])];
    logger.info({ policy: describePolicy(policy), deniedTools: deniedTools.length }, '[ScheduledTasks] Enabled');

    this.scheduler.registerTaskRunner(async request => {
      const decision = consumeTaskBudget(budget, policy, request.roomKey);
      if (!decision.allowed) {
        logTaskRefusal(request.roomKey, decision.reason);
        return;
      }
      const provider = this.operationalProviders().find(candidate => candidate.name === request.platform);
      if (!provider) {
        logTaskRefusal(request.roomKey, `platform ${request.platform} is not operational`);
        return;
      }
      const ctx = this.buildScheduledTaskContext(request, provider, deniedTools);
      try {
        await this.messageHandler(ctx);
      } catch (error) {
        logger.error({ err: error, roomKey: request.roomKey }, '[ScheduledTasks] Task run failed');
      }
    });
  }

  /**
   * Build the synthetic context for an unattended run.
   *
   * It carries the instruction as the message text, the room's canonical key and
   * the tool deny-list. Everything else is the *complete* `MessageContext`
   * surface, because the agent calls it unconditionally: `handleIncomingMessage`
   * begins with `await ctx.resolveRoles()`, so a partial object threw a
   * `TypeError` on the first line of every scheduled run — the reminder was
   * still marked delivered and the daily budget was still charged.
   *
   * With no human present the capabilities are the least-privileged ones that
   * still let the model answer: it can send text and nothing else. Presence
   * indicators, streaming edits, reactions, downloads and deletions have no
   * meaning for a synthetic message, and outbound mutations are refused
   * outright rather than silently no-op'd, so a tool that reaches for one fails
   * loudly instead of pretending to have acted.
   */
  private buildScheduledTaskContext(
    request: { platform: string; remoteRoomId: string; roomKey: string; language: string; instruction: string; signal?: AbortSignal },
    provider: BotProvider,
    deniedToolNames: readonly string[],
  ): MessageContext {
    const language = request.language === 'id' ? 'id' : 'en';
    const sendText: NonNullable<MessageContext['reply']> = async text => {
      if (request.signal?.aborted) return;
      if (request.signal) await provider.sendMessage(request.remoteRoomId, text, request.signal);
      else await provider.sendMessage(request.remoteRoomId, text);
    };
    const refuse = (capability: string) => async (): Promise<never> => {
      throw new ScheduledTaskCapabilityError(capability);
    };
    // The scheduler is not a person and holds no role, so it gets exactly the
    // baseline role. `checkPermissions` therefore refuses anything above it,
    // which is what makes an instruction that looks like a slash command safe.
    const roles = SCHEDULED_TASK_ROLES;
    return {
      platform: request.platform as MessageContext['platform'],
      chatId: request.remoteRoomId,
      roomKey: request.roomKey,
      deniedToolNames,
      senderId: 'scheduler',
      senderName: 'scheduler',
      text: request.instruction,
      isGroup: true,
      messageType: 'text',
      hasMedia: false,
      mediaReady: Promise.resolve(),
      language,
      receivedAt: Date.now(),
      rawMessage: null,
      signal: request.signal,
      isBotMentioned: true,
      reply: sendText,
      sendMessage: sendText,
      messageId: scheduledTaskMessageId(request),
      // Presence and streaming have no meaning without an inbound message.
      sendTyping: async () => {},
      editMessage: async () => {},
      react: async () => {},
      // Nothing to download, and nothing to hand a tool to write to.
      downloadMedia: async () => null,
      sendMedia: refuse('sendMedia'),
      sendSticker: refuse('sendSticker'),
      deleteMessage: refuse('deleteMessage'),
      forwardMessage: refuse('forwardMessage'),
      resolveRoles: async () => [...roles],
      checkPermissions: async required => hasRequiredRoleFor(roles, required),
    };
  }

  private startBackgroundTasks(): void {
    this.rateLimiterTimer = this.timers.setInterval(() => this.rateLimiter.prune(), 10 * 60 * 1000);
    if (hasDurableMessagingStore()) {
      this.processOutbox();
      this.outboxTimer = this.timers.setInterval(() => this.processOutbox(), 1_000);
      this.runRetention();
      this.retentionTimer = this.timers.setInterval(() => this.runRetention(), 24 * 60 * 60 * 1000);
    }
    this.mediaCleanupPromise = this.mediaCleanup.pruneOldFiles()
      .catch((err) => logger.warn({ err }, '[MediaCleanup] Initial prune failed'))
      .finally(() => { this.mediaCleanupPromise = null; });

    const rawMediaCleanupInterval = process.env.MEDIA_CLEANUP_INTERVAL_MS;
    const mediaCleanupIntervalMs = resolveMediaCleanupIntervalMs(rawMediaCleanupInterval);
    if (rawMediaCleanupInterval && mediaCleanupIntervalMs !== parseInt(rawMediaCleanupInterval, 10)) {
      logger.warn(
        { raw: rawMediaCleanupInterval, using: mediaCleanupIntervalMs },
        '[MediaCleanup] Invalid MEDIA_CLEANUP_INTERVAL_MS; falling back to default',
      );
    }

    this.mediaCleanupTimer = this.timers.setInterval(() => {
      this.mediaCleanupPromise = this.mediaCleanup.pruneOldFiles().catch((err) => {
        logger.warn({ err }, '[MediaCleanup] Periodic prune failed');
      }).finally(() => {
        this.mediaCleanupPromise = null;
      });
    }, mediaCleanupIntervalMs);

    if (this.runStartupCoverageScan) {
      this.startupCoverageTimer = this.timers.setTimeout(() => {
        void this.runStartupCoverageScan?.().catch((err) => {
          logger.warn({ err }, '[ParserCoverage] Startup scan failed (non-fatal)');
        });
      }, this.startupCoverageDelayMs);
    }
  }

  private runRetention(): void {
    if (!hasDurableMessagingStore() || this.retentionPromise) return;
    this.retentionPromise = Promise.resolve()
      .then(() => {
        runRetentionMaintenance();
      })
      .catch(error => logger.error({ err: error }, 'Retention maintenance failed'))
      .finally(() => { this.retentionPromise = null; });
  }

  private processOutbox(): void {
    if (!hasDurableMessagingStore() || this.outboxPromise) return;
    const providers = new Map<string, BotProvider>(this.operationalProviders().map(provider => [provider.name, provider]));
    if (providers.size === 0) return;
    this.outboxPromise = (async () => {
      const claimed = OutboxService.claim(this.outboxOwner, [...providers.keys()], 10);
      // Deliver the batch concurrently. The deliveries used to run one after
      // another with a 15 s timeout each, so a batch of ten could hold the
      // worker for 150 s — and the in-flight guard kept every later tick from
      // starting, so the queue drained at roughly one message per 15 s.
      await Promise.all(claimed.map(message => this.deliverOutboxMessage(message, providers)));
    })().catch(error => {
      logger.error({ err: error }, 'Outbox worker failed');
    }).finally(() => {
      this.outboxPromise = null;
    });
  }

  /** Deliver one claimed outbox row. Never throws — failures are recorded. */
  private async deliverOutboxMessage(
    message: { id: string; platform: string; chatRoomId: string; roomKey: string | null; text: string },
    providers: Map<string, BotProvider>,
  ): Promise<void> {
    const provider = providers.get(message.platform);
    try {
      if (!provider) throw new Error(`No provider for ${message.platform}`);
      // Rows are filed under a canonical room key but providers only accept
      // raw remote room ids; refuse to leak a key or another platform's room.
      const mismatch = providerRoomTargetMismatch(message.platform, message.roomKey, message.chatRoomId);
      if (mismatch) throw new Error(`Refusing unsafe outbox target: ${mismatch}`);
      const result = await withCancellableTimeout(
        signal => provider.sendMessage(message.chatRoomId, message.text, signal),
        15_000,
        'outbox delivery',
      );
      const providerMessageId = typeof result === 'string' ? result : null;
      if (!OutboxService.markSent(message.id, this.outboxOwner, providerMessageId)) {
        logger.warn({ id: message.id }, 'Outbox message was not owned during completion');
      }
    } catch (error) {
      OutboxService.fail(message.id, this.outboxOwner, error);
      logger.error({ err: error, id: message.id, platform: message.platform }, 'Outbox delivery failed');
    }
  }

  private async stopBackgroundTasks(): Promise<void> {
    if (this.rateLimiterTimer) {
      this.timers.clearInterval(this.rateLimiterTimer);
      this.rateLimiterTimer = null;
    }

    if (this.outboxTimer) {
      this.timers.clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
    if (this.retentionTimer) {
      this.timers.clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    if (this.outboxPromise) await this.outboxPromise;
    if (this.retentionPromise) await this.retentionPromise;

    if (this.mediaCleanupTimer) {
      this.timers.clearInterval(this.mediaCleanupTimer);
      this.mediaCleanupTimer = null;
    }

    if (this.startupCoverageTimer) {
      this.timers.clearTimeout(this.startupCoverageTimer);
      this.startupCoverageTimer = null;
    }

    if (this.mediaCleanupPromise) {
      await this.mediaCleanupPromise;
    }
  }
}
