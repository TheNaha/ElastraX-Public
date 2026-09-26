import { handleIncomingMessage } from '../agent';
import { MessageContext } from '../core/MessageContext';
import { BotProvider } from '../providers/BotProvider';
import { DiscordProvider } from '../providers/discord';
import { WhatsAppProvider } from '../providers/whatsapp';
import { MessageQueue, type MessageQueueStats } from '../utils/MessageQueue';
import { MediaCleanup } from '../utils/MediaCleanup';
import { RateLimiter } from '../utils/RateLimiter';
import { Scheduler } from '../utils/Scheduler';
import { DigestService } from '../utils/DigestService';
import { healthMetrics } from '../utils/HealthMetrics';
import { logger } from '../utils/logger';
import { WebhookServer } from '../webhookServer';
import { healthMonitor, type HealthMonitor } from '../utils/HealthMonitor';
import { getMediaCleanupIntervalMs, getQueueConfig } from '../config/runtime';
import { registryReady } from '../tools';
import { safeRegisterFlows } from '../flows/registry';
import { isSchemaReady, sqlite } from '../db';
import { runRetentionMaintenance } from '../db/maintenance';
import { InboxService } from '../messaging/InboxService';
import { OutboxService } from '../messaging/OutboxService';
import { providerRoomTargetMismatch, resolveCanonicalRoomKey } from '../messaging/roomKeys';
import type {
  WebhookEnqueuer,
  WebhookReadinessCheck,
} from '../webhooks/types';
import { withCancellableTimeout } from '../utils/withTimeout';
import { randomUUID } from 'node:crypto';

type SenderFn = (chatId: string, text: string, signal?: AbortSignal) => Promise<void>;

type SenderRegistry = {
  registerSender(platform: string, send: SenderFn): void | (() => void);
  start(): void;
  stop(): void;
  registerReadinessCheck?(check: WebhookReadinessCheck): () => void;
  registerEnqueuer?(enqueuer: WebhookEnqueuer): () => void;
  unregisterSender?(platform: string): void;
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

  constructor(deps: AppRuntimeDeps = {}) {
    this.providers = deps.providers ?? [new WhatsAppProvider(), new DiscordProvider()];
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

    // Wait for the tool registry (core tools + plugins) before accepting messages,
    // so slash commands and LLM tool lookups never hit an empty registry.
    await registryReady;

    // Register all flow processors in a centralized location.
    await safeRegisterFlows();

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
      this.registerProviderSenders();
      const unregisterReadiness = this.webhookServer.registerReadinessCheck?.(() => this.getReadiness().ready);
      if (unregisterReadiness) this.unregisterWebhookHooks.push(unregisterReadiness);
      const unregisterEnqueuer = this.webhookServer.registerEnqueuer?.(this.enqueueWebhook);
      if (unregisterEnqueuer) this.unregisterWebhookHooks.push(unregisterEnqueuer);
      await Promise.resolve(this.webhookServer.start());
      await Promise.resolve(this.scheduler.start());
      await Promise.resolve(this.digestService.start());
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
  } {
    const providers = Object.fromEntries(this.providers.map(provider => [provider.name, provider.isOperational === true]));
    const queueStats = this.messageQueue.getStats?.() ?? {};
    const databaseReady = isSchemaReady();
    const queueReady = queueStats.stopped !== true;
    return {
      ready: this.started && databaseReady && queueReady && Object.values(providers).some(Boolean),
      checks: { database: databaseReady, queue: queueReady, providers },
    };
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopping) return;
    this.stopping = true;
    for (const unregister of [...this.unregisterWebhookHooks.splice(0), ...this.unregisterSenderHooks.splice(0)]) {
      try {
        unregister();
      } catch (error) {
        logger.warn({ err: error }, 'Webhook hook unregistration failed');
      }
    }

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
    } finally {
      this.activeProviders = [];
      this.started = false;
      this.stopping = false;
      logger.info('Graceful shutdown complete');
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
   */
  private inferWebhookPlatform(chatRoomId: string): string {
    if (chatRoomId.includes('@g.us') || chatRoomId.includes('@s.whatsapp.net') || chatRoomId.endsWith('@lid')) {
      return 'whatsapp';
    }
    if (/^\d+$/.test(chatRoomId)) return 'discord';
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
    const deliverable = new Set(this.operationalProviders().map(provider => provider.name));
    if (deliverable.size === 0) {
      logger.error({ route: job.route, destinations: job.destinations.length }, 'Rejecting webhook: no operational provider');
      return { accepted: false, deliveryId: '', acceptedAt: new Date().toISOString() };
    }
    const acceptedAt = new Date().toISOString();
    const eventKey = job.eventId ?? `${job.route}:${job.source}:${job.receivedAt}:${job.text}`;
    const deliveryIds = job.destinations.map(destination => {
      const platform = destination.platform ?? this.inferWebhookPlatform(destination.chatRoomId);
      const roomKey = destination.roomKey?.trim() || resolveCanonicalRoomKey(platform, destination.chatRoomId);
      return OutboxService.enqueueText(
        platform,
        destination.chatRoomId,
        job.text,
        ['webhook', job.route, eventKey, destination.platform ?? '', destination.chatRoomId, roomKey],
        { roomKey },
      );
    });
    if (signal.aborted) throw signal.reason ?? new Error('Webhook enqueue aborted');
    return {
      accepted: true,
      deliveryId: deliveryIds.join(','),
      acceptedAt,
    };
  };

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
      for (const message of claimed) {
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
    })().catch(error => {
      logger.error({ err: error }, 'Outbox worker failed');
    }).finally(() => {
      this.outboxPromise = null;
    });
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
