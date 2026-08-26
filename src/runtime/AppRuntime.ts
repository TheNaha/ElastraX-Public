import { handleIncomingMessage } from '../agent';
import { MessageContext } from '../core/MessageContext';
import { BotProvider } from '../providers/BotProvider';
import { DiscordProvider } from '../providers/discord';
import { WhatsAppProvider } from '../providers/whatsapp';
import { MessageQueue } from '../utils/MessageQueue';
import { MediaCleanup } from '../utils/MediaCleanup';
import { RateLimiter } from '../utils/RateLimiter';
import { Scheduler } from '../utils/Scheduler';
import { healthMetrics } from '../utils/HealthMetrics';
import { logger } from '../utils/logger';
import { WebhookServer } from '../webhookServer';
import { healthMonitor } from '../utils/HealthMonitor';
import { getMediaCleanupIntervalMs } from '../config/runtime';
import { registryReady } from '../tools';

type SenderFn = (chatId: string, text: string, platform?: string) => Promise<void>;

type SenderRegistry = {
  registerSender(platform: string, fn: SenderFn): void;
  start(): void;
  stop(): void;
};

type QueueController = Pick<MessageQueue, 'enqueue' | 'stop'> & Partial<Pick<MessageQueue, 'getStats'>>;

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
  handleIncomingMessage?: (ctx: MessageContext) => Promise<void>;
  rateLimiter?: Pick<typeof RateLimiter, 'prune'>;
  mediaCleanup?: Pick<typeof MediaCleanup, 'pruneOldFiles'>;
  timers?: TimerApi;
  runStartupCoverageScan?: () => Promise<void>;
  startupCoverageDelayMs?: number;
};

export function resolveMediaCleanupIntervalMs(rawMediaCleanupInterval: string | undefined): number {
  return getMediaCleanupIntervalMs({ MEDIA_CLEANUP_INTERVAL_MS: rawMediaCleanupInterval });
}

export class AppRuntime {
  private readonly providers: BotProvider[];
  private readonly messageQueue: QueueController;
  private readonly webhookServer: SenderRegistry;
  private readonly scheduler: SenderRegistry;
  private readonly messageHandler: (ctx: MessageContext) => Promise<void>;
  private readonly rateLimiter: Pick<typeof RateLimiter, 'prune'>;
  private readonly mediaCleanup: Pick<typeof MediaCleanup, 'pruneOldFiles'>;
  private readonly timers: TimerApi;
  private readonly runStartupCoverageScan?: () => Promise<void>;
  private readonly startupCoverageDelayMs: number;

  private rateLimiterTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private mediaCleanupTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private startupCoverageTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private mediaCleanupPromise: Promise<void> | null = null;
  private started = false;

  constructor(deps: AppRuntimeDeps = {}) {
    this.providers = deps.providers ?? [new WhatsAppProvider(), new DiscordProvider()];
    this.messageQueue = deps.messageQueue ?? new MessageQueue();
    this.webhookServer = deps.webhookServer ?? new WebhookServer();
    this.scheduler = deps.scheduler ?? Scheduler;
    this.messageHandler = deps.handleIncomingMessage ?? handleIncomingMessage;
    this.rateLimiter = deps.rateLimiter ?? RateLimiter;
    this.mediaCleanup = deps.mediaCleanup ?? MediaCleanup;
    this.timers = deps.timers ?? globalThis;
    this.runStartupCoverageScan = deps.runStartupCoverageScan;
    this.startupCoverageDelayMs = deps.startupCoverageDelayMs ?? 5000;

    const getStats = this.messageQueue.getStats?.bind(this.messageQueue);
    if (getStats) {
      healthMetrics.registerQueueStats(() => getStats());
    }
  }

  async start(): Promise<void> {
    if (this.started) return;

    // Wait for the tool registry (core tools + plugins) before accepting messages,
    // so slash commands and LLM tool lookups never hit an empty registry.
    await registryReady;

    const queuedHandler = async (ctx: MessageContext): Promise<void> => {
      this.messageQueue.enqueue(ctx.chatId, () => this.messageHandler(ctx));
    };

    for (const provider of this.providers) {
      provider.onMessage(queuedHandler);
    }

    for (const provider of this.providers) {
      try {
        await provider.start();
      } catch (err) {
        logger.error({ err, provider: provider.name }, 'Failed to start provider (non-fatal)');
      }
    }

    this.registerProviderSenders();
    this.webhookServer.start();
    this.scheduler.start();
    healthMonitor.start();
    this.startBackgroundTasks();

    this.started = true;
    logger.info('Bot is running. Press Ctrl+C to stop.');
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    await this.stopBackgroundTasks();
    this.scheduler.stop();
    this.webhookServer.stop();
    healthMonitor.stop();
    this.messageQueue.stop();

    for (const provider of this.providers) {
      await provider.stop();
    }

    this.started = false;
  }

  private registerProviderSenders(): void {
    for (const provider of this.providers) {
      const send = async (chatId: string, text: string, _platform?: string): Promise<void> => provider.sendMessage(chatId, text);
      this.webhookServer.registerSender(provider.name, send);
      this.scheduler.registerSender(provider.name, send);
    }
  }

  private startBackgroundTasks(): void {
    this.rateLimiterTimer = this.timers.setInterval(() => this.rateLimiter.prune(), 10 * 60 * 1000);

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

  private async stopBackgroundTasks(): Promise<void> {
    if (this.rateLimiterTimer) {
      this.timers.clearInterval(this.rateLimiterTimer);
      this.rateLimiterTimer = null;
    }

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
