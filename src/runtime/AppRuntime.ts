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
import { parseWebhookConfig } from '../webhooks/config';
import { healthMonitor, type HealthMonitor } from '../utils/HealthMonitor';
import { getMediaCleanupIntervalMs, getMediaRetentionHours, getQueueConfig } from '../config/runtime';
import { registryReady, mutatingToolNames } from '../tools';
import { safeRegisterFlows } from '../flows/registry';
import { FlowHandler } from '../core/FlowHandler';
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
import { pickWebhookText } from '../webhooks/utils';
import { getRoomLanguage } from '../db/roomLanguage';
import { withCancellableTimeout } from '../utils/withTimeout.js';
import { nowISO } from '../utils/date.js';
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
  enqueue(roomId: string, task: (signal?: AbortSignal) => Promise<void>, options?: { silent?: boolean }): unknown;
  stop(): void;
  /** Re-arms a queue that a previous shutdown stopped. Optional for test doubles. */
  resume?(): void;
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
 * Stable, non-placeholder id for one synthetic scheduled run.
 *
 * The message-id dedupe index deliberately excludes placeholder ids, and an
 * empty or `'unknown'` id made every stored run look like the *current* message,
 * which re-embedded up to `INLINE_MEDIA_MAX_BYTES` of history per turn.
 *
 * `firedAt` is part of the digest on purpose. It used to hash only
 * platform/room/instruction, so the second fire of the same `/task …` reminder
 * produced the same id, collided with the first run's stored `messages` row and
 * was dropped by the agent's duplicate guard — the room got exactly one reply
 * and then silence for the life of the retention window.
 */
/** Field separator for hashed composite keys, matching `OutboxService.idempotencyKey`. */
const FIELD_SEPARATOR = '\u0000';

/**
 * Monotonic per-process counter, so two fires in the same millisecond still get
 * distinct ids (`Date.now()` alone has millisecond resolution).
 */
let scheduledTaskSequence = 0;

function scheduledTaskMessageId(request: {
  platform: string;
  roomKey: string;
  instruction: string;
  firedAt: number;
}): string {
  scheduledTaskSequence += 1;
  const digest = createHash('sha256')
    .update(`${request.platform}${FIELD_SEPARATOR}${request.roomKey}${FIELD_SEPARATOR}${request.instruction}${FIELD_SEPARATOR}${request.firedAt}${FIELD_SEPARATOR}${scheduledTaskSequence}`)
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
  private outboxPruneTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private inboxRecoveryTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private flowSessionTtlTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private mediaCleanupTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private retentionTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private startupCoverageTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private mediaCleanupPromise: Promise<void> | null = null;
  private retentionPromise: Promise<void> | null = null;
  private startupCoveragePromise: Promise<void> | null = null;
  private activeProviders: BotProvider[] = [];
  /** Platforms whose outbound lanes are registered (avoids double registration). */
  private readonly senderPlatforms = new Set<string>();
  private unregisterWebhookHooks: Array<() => void> = [];
  private unregisterSenderHooks: Array<() => void> = [];
  private started = false;
  /**
   * The in-flight `stop()`, if any.
   *
   * `stop()` used to answer every caller that arrived while a teardown was
   * already running with a bare `return`, i.e. a resolved promise. The second
   * caller was `bootstrap`'s shutdown, which then closed the database and told
   * the process to exit while `provider.stop()` and `drainOutbox()` were still
   * using that handle. Sharing one promise makes every caller — including the
   * interrupted-boot path in `start()` — wait for the teardown that is actually
   * running instead of starting a second one.
   */
  private stopPromise: Promise<void> | null = null;

  /**
   * Persistent "has been shut down at least once" flag. `stop()` is idempotent:
   * once a shutdown has completed, a second `stop()` is a no-op. During boot
   * (`started` still false, `stopped` still false) a shutdown is NOT dropped —
   * `stop()` proceeds to `teardown()` so providers started mid-boot are always
   * released. `start()` resets this and `stopRequested`, and re-arms the queue.
   */
  private stopped = false;

  /**
   * Set the moment a shutdown is requested, including while `start()` is still
   * awaiting provider connections. `start()` checks this flag at every await
   * boundary and unwinds instead of binding the HTTP listener against a
   * database the shutdown path has already closed.
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
    // A restart that begins while a teardown is still running would re-arm the
    // queue and re-register hooks that the running teardown then stops (and it
    // would leave `started` true over a dead runtime). Wait for it first.
    if (this.stopPromise) await this.stopPromise;
    this.stopRequested = false;
    this.stopped = false;
    // A previous shutdown stopped the queue permanently; without this a
    // stop/start cycle in one process refuses every inbound message and reports
    // `queue: stopped` on /ready for the rest of the process's life.
    this.messageQueue.resume?.();

    // Wait for the tool registry (core tools + plugins) before accepting messages,
    // so slash commands and LLM tool lookups never hit an empty registry.
    await registryReady;

    // Register all flow processors in a centralized location.
    await safeRegisterFlows();

    // Parse the webhook configuration before any provider connects.
    // `webhookServer.start()` parses it again, but by then WhatsApp/Discord/
    // Telegram have already joined and the catch below tears them all down: a
    // single typo in a WEBHOOK_* value used to take the whole bot down *after*
    // the providers were connected, which is the most disruptive moment to
    // restart. Failing here leaves nothing to unwind.
    parseWebhookConfig(process.env, Date.now());

    if (this.stopRequested) {
      logger.info('Startup interrupted before providers were started');
      return;
    }

    const queuedHandler = async (ctx: MessageContext): Promise<void> => {
      if (this.stopRequested) {
        logger.info({ chatId: ctx.chatId, platform: ctx.platform }, 'Incoming message dropped: runtime stopping');
        return;
      }
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
        // A duplicate admission means the provider delivered an event whose row
        // is already in `failed` with a backoff: this is a live redelivery, so it
        // may skip the backoff the worker set for itself. A first admission keeps
        // the backoff predicate.
        if (!InboxService.claim(admission.id, this.inboxOwner, { allowBackoff: admission.reason === 'duplicate' })) {
          // A duplicate that loses this race is another delivery of an event the
          // queue already holds; expected, so it is debug. A first admission that
          // cannot be claimed means the ledger is not in the state `admit` just
          // reported, which is worth a warning.
          const context = { chatId: ctx.chatId, platform: ctx.platform, inboxId: admission.id };
          if (admission.reason === 'duplicate') {
            logger.debug(context, 'Duplicate delivery was already claimed by another task');
          } else {
            logger.warn(context, 'Inbox row could not be claimed; the event was not processed');
          }
          return;
        }
        try {
          await this.messageHandler(ctx);
          if (!InboxService.complete(admission.id, this.inboxOwner)) {
            // The row is no longer leased by this worker (lease expired and a
            // recovery scan returned it to `received`). The turn still ran, so
            // surface it: silently ignoring the result hid a lost completion.
            logger.warn({ chatId: ctx.chatId, platform: ctx.platform, inboxId: admission.id }, 'Inbox completion was not owned by this worker');
          }
        } catch (error) {
          InboxService.fail(admission.id, this.inboxOwner, error);
          throw error;
        }
      };

      let accepted = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        // Silent on every retry but the last: this loop may try 80 times for one
        // message, and counting each rejection inflated `droppedTasks` by 80 and
        // logged 80 warnings for a single drop. The final attempt counts and logs
        // exactly once (and still wins if a slot freed up).
        accepted = this.messageQueue.enqueue(roomKey, task, { silent: attempt < 79 }) !== false;
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
      // the shutdown path has already closed. `stop()` is shared, so this joins
      // a teardown that is already running rather than tearing down twice
      // against providers the first pass has stopped.
      logger.info('Startup interrupted while providers were connecting; unwinding');
      await this.stop();
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
   * Providers currently able to accept an outbound send.
   *
   * Deliberately derived from the full provider list rather than the boot-time
   * `activeProviders` snapshot. A provider whose `start()` rejected while it
   * scheduled its own reconnect (WhatsApp, Telegram) is absent from that
   * snapshot forever, so every durable lane — webhook enqueue, the outbox claim,
   * scheduled runs — would exclude that platform for the life of the process even
   * after the retry loop connected it. Reading `isOperational` live makes the
   * lanes self-healing; `activeProviders` still decides whose `start()` resolved
   * and therefore who gets senders registered at boot.
   */
  private operationalProviders(): BotProvider[] {
    return this.providers.filter(provider =>
      provider.isOperational === true
      // A test double that does not model operational state counts as
      // operational only if its `start()` resolved.
      || (provider.isOperational === undefined && this.activeProviders.includes(provider)),
    );
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
    // A caller that arrives mid-teardown must wait for it, not be told it is
    // already done: bootstrap closes the database as soon as this resolves.
    if (this.stopPromise) return this.stopPromise;
    if (!this.started && this.stopped) return;
    this.stopPromise = (async () => {
      try {
        await this.teardown();
      } finally {
        this.activeProviders = [];
        this.started = false;
        this.stopped = true;
        this.stopPromise = null;
        logger.info('Graceful shutdown complete');
      }
    })();
    return this.stopPromise;
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

    for (const provider of this.providers) {
      this.scheduler.unregisterSender?.(provider.name);
      this.digestService.unregisterSender?.(provider.name);
      provider.onMessage?.(async () => {});
    }
    this.senderPlatforms.clear();
    try {
      await this.stopBackgroundTasks();
      this.digestService.stop();
      this.scheduler.stop();
      await this.webhookServer.stop();
      this.healthMon.stop();
      if (this.messageQueue.closeAndDrain) {
        await this.messageQueue.closeAndDrain();
      } else {
        this.messageQueue.stop();
      }
      await this.drainOutbox();
      await Promise.allSettled(this.providers.map(async provider => {
        try {
          await Promise.race([
            provider.stop(),
            new Promise<void>((_, reject) => {
              const timer = setTimeout(() => reject(new Error(`Provider ${provider.name} stop timed out`)), 10_000);
              timer.unref?.();
            }),
          ]);
        } catch (error) {
          logger.error({ err: error, provider: provider.name }, 'Provider stop failed during teardown');
        }
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
    // A provider that connected after boot must be usable by the first webhook
    // that arrives, not only after the next outbox tick.
    this.reconcileProviderAdmission();
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
      return { accepted: false, deliveryId: '', acceptedAt: nowISO() };
    }
    const acceptedAt = nowISO();
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
      // Each destination gets its own rendering: one webhook fans out to rooms
      // that may be set to different languages.
      const language = destination.language ?? getRoomLanguage(roomKey);
      deliveryIds.push(OutboxService.enqueueText(
        platform,
        destination.chatRoomId,
        pickWebhookText(job, language),
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
      this.registerSenderFor(provider);
    }
  }

  /**
   * Register the outbound lanes for one provider. Idempotent: a provider whose
   * sender is already wired is skipped, so the reconcile pass cannot stack a
   * second sender registration on the same platform.
   */
  private registerSenderFor(provider: BotProvider): void {
    if (this.senderPlatforms.has(provider.name)) return;
    const send: SenderFn = async (chatId: string, text: string, signal?: AbortSignal) => {
      if (signal) await provider.sendMessage(chatId, text, signal);
      else await provider.sendMessage(chatId, text);
    };
    const unregister = this.webhookServer.registerSender(provider.name, send);
    if (unregister) this.unregisterSenderHooks.push(unregister);
    this.scheduler.registerSender(provider.name, send);
    this.digestService.registerSender(provider.name, send);
    this.senderPlatforms.add(provider.name);
  }

  /**
   * Wire the outbound lanes of a provider that only became operational after
   * boot — the reconnect path a provider takes when its first `start()` failed.
   * Without this, the platform could connect and still have no scheduler, digest
   * or webhook sender for the rest of the process.
   */
  private reconcileProviderAdmission(): void {
    if (!this.started || this.stopRequested) return;
    for (const provider of this.providers) {
      if (this.senderPlatforms.has(provider.name)) continue;
      if (provider.isOperational !== true) continue;
      logger.info({ provider: provider.name, status: provider.status }, 'Provider became operational after boot; wiring senders');
      this.registerSenderFor(provider);
      if (!this.activeProviders.includes(provider)) this.activeProviders.push(provider);
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
      messageId: scheduledTaskMessageId({ ...request, firedAt: Date.now() }),
      // Presence, streaming and progress have no meaning without an inbound
      // message. Both hooks are left absent rather than stubbed: a stub that
      // returns `undefined` still passed the agent's streaming capability check
      // and every "edit" was a no-op, so the run sent truncated previews ending
      // in a cursor and then recorded the real answer as already delivered.
      // Absent hooks make the agent take the plain `reply` path.
      sendTyping: async () => {},
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
    this.rateLimiterTimer?.unref?.();
    if (hasDurableMessagingStore()) {
      this.processOutbox();
      this.outboxTimer = this.timers.setInterval(() => this.processOutbox(), 1_000);
      this.outboxTimer?.unref?.();
      this.runRetention();
      this.retentionTimer = this.timers.setInterval(() => this.runRetention(), 24 * 60 * 60 * 1000);
      this.retentionTimer?.unref?.();
    }
    // Prune terminal outbox rows (failed / dead_letter) older than the media
    // retention window so they don't accumulate indefinitely.
    const outboxPruneMs = getMediaRetentionHours() * 60 * 60 * 1000;
    this.outboxPruneTimer = this.timers.setInterval(() => {
      try {
        const pruned = OutboxService.prune(outboxPruneMs);
        if (pruned > 0) logger.info({ pruned }, '[Outbox] Pruned terminal rows');
      } catch (error) {
        logger.warn({ err: error }, '[Outbox] Prune failed');
      }
    }, 60 * 60 * 1000);
    this.outboxPruneTimer.unref?.();

    // Recover stranded inbox rows (received but never claimed, or processing
    // with an expired lease) so they are not lost forever.
    this.inboxRecoveryTimer = this.timers.setInterval(() => {
      try {
        const recovered = InboxService.recoverStranded(24 * 60 * 60 * 1000);
        if (recovered.received > 0 || recovered.processing > 0) {
          logger.info(recovered, '[Inbox] Recovered stranded rows');
        }
      } catch (error) {
        logger.warn({ err: error }, '[Inbox] Recovery scan failed');
      }
    }, 60 * 60 * 1000);
    this.inboxRecoveryTimer.unref?.();

    // Prune expired flow sessions so abandoned wizard state doesn't accumulate.
    this.flowSessionTtlTimer = this.timers.setInterval(() => {
      try {
        void FlowHandler.pruneAllExpired().catch((error: unknown) =>
          logger.warn({ err: error }, '[FlowHandler] TTL prune failed'),
        );
      } catch (error) {
        logger.warn({ err: error }, '[FlowHandler] TTL prune scheduler failed');
      }
    }, 60 * 60 * 1000);
    this.flowSessionTtlTimer.unref?.();

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
      if (this.mediaCleanupPromise) return;
      this.mediaCleanupPromise = this.mediaCleanup.pruneOldFiles().catch((err) => {
        logger.warn({ err }, '[MediaCleanup] Periodic prune failed');
      }).finally(() => {
        this.mediaCleanupPromise = null;
      });
    }, mediaCleanupIntervalMs);
    this.mediaCleanupTimer?.unref?.();

    if (this.runStartupCoverageScan) {
      this.startupCoverageTimer = this.timers.setTimeout(() => {
        const scan = this.runStartupCoverageScan;
        if (!scan) return;
        this.startupCoveragePromise = scan().catch((err) => {
          logger.warn({ err }, '[ParserCoverage] Startup scan failed (non-fatal)');
        }).finally(() => { this.startupCoveragePromise = null; });
      }, this.startupCoverageDelayMs);
      this.startupCoverageTimer?.unref?.();
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
    // A provider that finished connecting after boot gets its lanes here.
    this.reconcileProviderAdmission();
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

  private async drainOutbox(timeoutMs = 15_000): Promise<void> {
    if (!hasDurableMessagingStore()) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.outboxPromise) await this.outboxPromise;
      const providers = new Map<string, BotProvider>(this.operationalProviders().map(provider => [provider.name, provider]));
      if (providers.size === 0) break;
      const claimed = OutboxService.claim(this.outboxOwner, [...providers.keys()], 10);
      if (claimed.length === 0) break;
      await Promise.all(claimed.map(message => this.deliverOutboxMessage(message, providers)));
    }
  }

  /** Deliver one claimed outbox row. Never throws — failures are recorded. */
  private async deliverOutboxMessage(
    message: { id: string; platform: string; chatRoomId: string; roomKey: string | null; text: string; mentions?: string[] },
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
        signal => provider.sendMessage(message.chatRoomId, message.text, signal, {
          ...(message.mentions?.length ? { mentions: message.mentions } : {}),
        }),
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
    // Clear all interval timers
    this._clearTimer(this.rateLimiterTimer);
    this._clearTimer(this.outboxTimer);
    this._clearTimer(this.outboxPruneTimer);
    this._clearTimer(this.inboxRecoveryTimer);
    this._clearTimer(this.flowSessionTtlTimer);
    this._clearTimer(this.mediaCleanupTimer);
    this._clearTimer(this.retentionTimer);

    // Clear timeouts
    this._clearTimeout(this.startupCoverageTimer);

    // Await any in-flight promises
    if (this.outboxPromise) await this.outboxPromise;
    if (this.retentionPromise) await this.retentionPromise;
    if (this.mediaCleanupPromise) await this.mediaCleanupPromise;
    if (this.startupCoveragePromise) await this.startupCoveragePromise;
  }

  private _clearTimer<T extends ReturnType<typeof globalThis.setInterval> | null>(
    timer: T,
  ): void {
    if (timer) {
      this.timers.clearInterval(timer);
    }
  }

  private _clearTimeout<T extends ReturnType<typeof globalThis.setTimeout> | null>(
    timeout: T,
  ): void {
    if (timeout) {
      this.timers.clearTimeout(timeout);
    }
  }
}
