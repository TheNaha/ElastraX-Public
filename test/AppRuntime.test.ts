import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import type { MessageContext } from '../src/core/MessageContext';
import type { BotProvider } from '../src/providers/BotProvider';
import type { AppRuntimeDeps } from '../src/runtime/AppRuntime';
import { AppRuntime, resolveMediaCleanupIntervalMs } from '../src/runtime/AppRuntime';
import { canonicalRoomKey } from '../src/messaging/roomKeys';
import { healthMetrics } from '../src/utils/HealthMetrics';

type FakeTimerHandle = { id: string };
type RegisteredSender = (chatId: string, text: string) => Promise<void>;

type FakeProvider = BotProvider & {
  capturedHandler: ((ctx: MessageContext) => Promise<void>) | null;
  start: ReturnType<typeof mock>;
  stop: ReturnType<typeof mock>;
  sendMessage: ReturnType<typeof mock>;
};

// The durable inbox dedupes on platform+event key against the shared worker DB,
// so every test needs its own room/message identity.
const runToken = Math.random().toString(36).slice(2, 10);

function createProvider(name: BotProvider['name']): FakeProvider {
  return {
    name,
    isOperational: true,
    capturedHandler: null,
    start: mock(async () => {}),
    stop: mock(async () => {}),
    sendMessage: mock(async () => {}),
    onMessage(handler) {
      this.capturedHandler = handler;
    },
  };
}

describe('AppRuntime', () => {
  const originalMediaCleanupInterval = process.env.MEDIA_CLEANUP_INTERVAL_MS;

  beforeEach(() => {
    delete process.env.MEDIA_CLEANUP_INTERVAL_MS;
  });

  afterEach(() => {
    if (originalMediaCleanupInterval === undefined) {
      delete process.env.MEDIA_CLEANUP_INTERVAL_MS;
    } else {
      process.env.MEDIA_CLEANUP_INTERVAL_MS = originalMediaCleanupInterval;
    }
  });

  test('start wires providers, senders, message queue, and background tasks', async () => {
    const whatsappProvider = createProvider('whatsapp');
    const discordProvider = createProvider('discord');
    const enqueue = mock((roomId: string, task: () => Promise<void>) => {
      void task();
      return roomId;
    });
    const messageQueue = {
      enqueue,
      stop: mock(() => {}),
    };
    const webhookServer = {
      registerSender: mock((_platform: string, _fn: RegisteredSender) => {}),
      start: mock(() => {}),
      stop: mock(() => {}),
    };
    const scheduler = {
      registerSender: mock((_platform: string, _fn: RegisteredSender) => {}),
      start: mock(() => {}),
      stop: mock(() => {}),
    };
    const handleIncoming = mock(async (_ctx: MessageContext) => {});
    const pruneRateLimiter = mock(() => {});
    const pruneMedia = mock(async () => {});
    const runStartupCoverageScan = mock(async () => {});
    const intervalCallbacks: Array<() => void> = [];
    const timeoutCallbacks: Array<() => void> = [];
    const timers = {
      setInterval: mock((callback: () => void) => {
        intervalCallbacks.push(callback);
        return { id: `interval-${intervalCallbacks.length}` } as FakeTimerHandle;
      }),
      clearInterval: mock(() => {}),
      setTimeout: mock((callback: () => void) => {
        timeoutCallbacks.push(callback);
        return { id: `timeout-${timeoutCallbacks.length}` } as FakeTimerHandle;
      }),
      clearTimeout: mock(() => {}),
    };

    const runtime = new AppRuntime({
      providers: [whatsappProvider, discordProvider],
      messageQueue,
      webhookServer,
      scheduler,
      handleIncomingMessage: handleIncoming,
      rateLimiter: { prune: pruneRateLimiter },
      mediaCleanup: { pruneOldFiles: pruneMedia },
      timers: timers as unknown as AppRuntimeDeps['timers'],
      runStartupCoverageScan,
      startupCoverageDelayMs: 250,
    });

    await runtime.start();

    expect(whatsappProvider.start).toHaveBeenCalledTimes(1);
    expect(discordProvider.start).toHaveBeenCalledTimes(1);
    expect(webhookServer.registerSender).toHaveBeenCalledTimes(2);
    expect(scheduler.registerSender).toHaveBeenCalledTimes(2);
    expect(webhookServer.start).toHaveBeenCalledTimes(1);
    expect(scheduler.start).toHaveBeenCalledTimes(1);
    // rate limiter, outbox pump, retention sweep, media cleanup, outbox prune,
    // inbox recovery, flow session TTL.
    expect(timers.setInterval).toHaveBeenCalledTimes(7);
    expect(timers.setTimeout).toHaveBeenCalledTimes(1);

    const ctx = {
      platform: 'whatsapp',
      chatId: `room-1-${runToken}`,
      senderId: 'user-1',
      senderName: 'Alice',
      text: 'hello',
      messageId: `msg-1-${runToken}`,
      messageType: 'conversation',
      isGroup: false,
      isBotMentioned: false,
      hasMedia: false,
      mediaReady: Promise.resolve(),
      rawMessage: {},
      reply: mock(async () => {}),
      checkPermissions: mock(async () => true),
      resolveRoles: mock(async () => ['user']),
    } as unknown as MessageContext;

    await whatsappProvider.capturedHandler?.(ctx);

    // Durable work is keyed on the canonical room key; the context keeps the
    // raw provider room id for provider I/O.
    const roomKey = canonicalRoomKey('whatsapp', `room-1-${runToken}`);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(roomKey, expect.any(Function), expect.objectContaining({ silent: expect.any(Boolean) }));
    expect(handleIncoming).toHaveBeenCalledWith(ctx);
    expect(handleIncoming.mock.calls[0]?.[0]?.roomKey).toBe(roomKey);
    expect(handleIncoming.mock.calls[0]?.[0]?.chatId).toBe(`room-1-${runToken}`);

    const whatsappWebhookSender = webhookServer.registerSender.mock.calls[0]?.[1];
    const discordSchedulerSender = scheduler.registerSender.mock.calls[1]?.[1];

    expect(whatsappWebhookSender).toBeDefined();
    expect(discordSchedulerSender).toBeDefined();
    if (!whatsappWebhookSender || !discordSchedulerSender) {
      throw new Error('Expected sender callbacks to be registered');
    }

    await whatsappWebhookSender('wa-room', 'hello');
    await discordSchedulerSender('dc-room', 'world');

    expect(whatsappProvider.sendMessage).toHaveBeenCalledWith('wa-room', 'hello');
    expect(discordProvider.sendMessage).toHaveBeenCalledWith('dc-room', 'world');

    intervalCallbacks[0]?.();
    timeoutCallbacks[0]?.();
    await Promise.resolve();

    expect(pruneRateLimiter).toHaveBeenCalledTimes(1);
    expect(runStartupCoverageScan).toHaveBeenCalledTimes(1);
  });

  test('stop clears timers and shuts down services idempotently', async () => {
    const provider = createProvider('whatsapp');
    const messageQueue = {
      enqueue: mock(() => {}),
      stop: mock(() => {}),
    };
    const webhookServer = {
      registerSender: mock((_platform: string, _fn: RegisteredSender) => {}),
      start: mock(() => {}),
      stop: mock(() => {}),
    };
    const scheduler = {
      registerSender: mock((_platform: string, _fn: RegisteredSender) => {}),
      start: mock(() => {}),
      stop: mock(() => {}),
    };
    const timers = {
      setInterval: mock(() => ({ id: 'interval' } as FakeTimerHandle)),
      clearInterval: mock(() => {}),
      setTimeout: mock(() => ({ id: 'timeout' } as FakeTimerHandle)),
      clearTimeout: mock(() => {}),
    };

    const runtime = new AppRuntime({
      providers: [provider],
      messageQueue,
      webhookServer,
      scheduler,
      timers: timers as unknown as AppRuntimeDeps['timers'],
      runStartupCoverageScan: async () => {},
    });

    await runtime.start();
    await runtime.stop();
    await runtime.stop();

    expect(timers.clearInterval).toHaveBeenCalledTimes(7);
    expect(timers.clearTimeout).toHaveBeenCalledTimes(1);
    expect(scheduler.stop).toHaveBeenCalledTimes(1);
    expect(webhookServer.stop).toHaveBeenCalledTimes(1);
    expect(messageQueue.stop).toHaveBeenCalledTimes(1);
    expect(provider.stop).toHaveBeenCalledTimes(1);
  });

  test('admits a provider that only becomes operational after boot', async () => {
    // A provider whose first start() failed still retries on its own. Once that
    // retry connects, the platform must get its outbound lanes back without a
    // process restart: webhook enqueue and the outbox both read
    // operationalProviders().
    const provider = createProvider('whatsapp');
    let operational = false;
    Object.defineProperty(provider, 'isOperational', { get: () => operational, configurable: true });
    provider.start = mock(async () => {
      throw new Error('boot blip');
    });
    const messageQueue = { enqueue: mock(() => {}), stop: mock(() => {}) };
    const registeredSenders = new Map<string, RegisteredSender>();
    const webhookServer = {
      registerSender: mock((platform: string, fn: RegisteredSender) => {
        registeredSenders.set(platform, fn);
        return () => registeredSenders.delete(platform);
      }),
      registerEnqueuer: mock((_enqueuer: unknown) => () => {}),
      start: mock(() => {}),
      stop: mock(() => {}),
    };
    const registeredEnqueuers: Array<(job: unknown, signal: AbortSignal) => Promise<{ accepted: boolean }>> = [];
    webhookServer.registerEnqueuer = mock((enqueuer: unknown) => {
      registeredEnqueuers.push(enqueuer as (job: unknown, signal: AbortSignal) => Promise<{ accepted: boolean }>);
      return () => {};
    });
    const scheduler = {
      registerSender: mock((_platform: string, _fn: RegisteredSender) => {}),
      unregisterSender: mock((_platform: string) => {}),
      start: mock(() => {}),
      stop: mock(() => {}),
    };
    const timers = {
      setInterval: mock(() => ({ id: 'interval' } as FakeTimerHandle)),
      clearInterval: mock(() => {}),
      setTimeout: mock(() => ({ id: 'timeout' } as FakeTimerHandle)),
      clearTimeout: mock(() => {}),
    };

    const runtime = new AppRuntime({
      providers: [provider],
      messageQueue,
      webhookServer,
      scheduler,
      timers: timers as unknown as AppRuntimeDeps['timers'],
    });

    await runtime.start();

    expect(provider.start).toHaveBeenCalledTimes(1);
    expect(webhookServer.registerSender).not.toHaveBeenCalled();
    expect(runtime.getReadiness().checks.providers.whatsapp).toBe(false);

    // The provider's own reconnect loop connects it later.
    operational = true;

    const enqueuer = registeredEnqueuers[0];
    if (!enqueuer) throw new Error('expected the webhook enqueuer to be registered');
    const result = await enqueuer({
      route: 'generic',
      source: 'test',
      text: 'hello',
      receivedAt: new Date().toISOString(),
      destinations: [{ chatRoomId: `late-room-${runToken}`, platform: 'whatsapp' }],
    }, new AbortController().signal);

    expect(result.accepted).toBe(true);
    expect(webhookServer.registerSender).toHaveBeenCalledTimes(1);
    expect(scheduler.registerSender).toHaveBeenCalledTimes(1);

    await runtime.stop();
  });

  test('drops incoming messages when stopRequested is set', async () => {
    const provider = createProvider('whatsapp');
    let enqueued = false;
    const messageQueue = {
      enqueue: mock(() => { enqueued = true; return true; }),
      stop: mock(() => {}),
    };
    const runtime = new AppRuntime({
      providers: [provider],
      messageQueue,
      webhookServer: {
        registerSender: mock(() => {}),
        start: mock(() => {}),
        stop: mock(() => {}),
      },
      scheduler: {
        registerSender: mock(() => {}),
        start: mock(() => {}),
        stop: mock(() => {}),
      },
      runStartupCoverageScan: async () => {},
    });

    await runtime.start();
    const handler = provider.capturedHandler;
    expect(handler).not.toBeNull();

    await runtime.stop();

    await handler!({
      platform: 'whatsapp',
      chatId: 'wa-chat',
      senderId: 'wa-user',
      text: 'hello during shutdown',
      messageId: 'msg-shutdown',
      receivedAt: Date.now(),
      messageType: 'conversation',
      isGroup: false,
      isBotMentioned: false,
      hasMedia: false,
      rawMessage: {},
      language: 'en',
    } as unknown as MessageContext);

    expect(enqueued).toBe(false);
  });

  test('a scheduled run has a per-fire message id and no streaming surface', async () => {
    const originalEnabled = process.env.SCHEDULED_TASKS_ENABLED;
    const originalRooms = process.env.SCHEDULED_TASKS_ALLOWED_ROOMS;
    const roomKey = canonicalRoomKey('whatsapp', 'wa-scheduled-room');
    process.env.SCHEDULED_TASKS_ENABLED = 'true';
    process.env.SCHEDULED_TASKS_ALLOWED_ROOMS = roomKey;

    const provider = createProvider('whatsapp');
    const messageQueue = { enqueue: mock(() => {}), stop: mock(() => {}) };
    const webhookServer = {
      registerSender: mock((_platform: string, _fn: RegisteredSender) => {}),
      start: mock(() => {}),
      stop: mock(() => {}),
    };
    let runner: ((request: Record<string, unknown>) => Promise<void>) | null = null;
    const scheduler = {
      registerSender: mock((_platform: string, _fn: RegisteredSender) => {}),
      registerTaskRunner: mock((fn: typeof runner) => { runner = fn; }),
      start: mock(() => {}),
      stop: mock(() => {}),
    };
    const captured: MessageContext[] = [];
    const handleIncoming = mock(async (ctx: MessageContext) => { captured.push(ctx); });

    try {
      const runtime = new AppRuntime({
        providers: [provider],
        messageQueue,
        webhookServer,
        scheduler,
        handleIncomingMessage: handleIncoming,
      });
      await runtime.start();

      const request = {
        platform: 'whatsapp',
        remoteRoomId: 'wa-scheduled-room',
        roomKey,
        language: 'en',
        instruction: 'summarise today',
      };
      // Two fires of the same recurrence must be two distinct events: a
      // content-derived id collided with the first run's stored message row and
      // the agent dropped the second run as a duplicate provider event.
      await runner!(request);
      await runner!(request);
      await runtime.stop();

      expect(captured).toHaveLength(2);
      expect(captured[0]!.messageId).not.toBe(captured[1]!.messageId);
      // No stubbed sendMessage/editMessage: with streaming enabled a stub sent
      // previews and then recorded the real answer as delivered without sending it.
      expect(captured[0]!.sendMessage).toBeUndefined();
      expect(captured[0]!.editMessage).toBeUndefined();
    } finally {
      if (originalEnabled === undefined) delete process.env.SCHEDULED_TASKS_ENABLED;
      else process.env.SCHEDULED_TASKS_ENABLED = originalEnabled;
      if (originalRooms === undefined) delete process.env.SCHEDULED_TASKS_ALLOWED_ROOMS;
      else process.env.SCHEDULED_TASKS_ALLOWED_ROOMS = originalRooms;
    }
  });

  test('resolveMediaCleanupIntervalMs keeps safe defaults', () => {
    expect(resolveMediaCleanupIntervalMs(undefined)).toBe(6 * 60 * 60 * 1000);
    expect(resolveMediaCleanupIntervalMs('invalid')).toBe(6 * 60 * 60 * 1000);
    expect(resolveMediaCleanupIntervalMs('59000')).toBe(6 * 60 * 60 * 1000);
    expect(resolveMediaCleanupIntervalMs('120000')).toBe(120000);
  });

  test('registers queue metrics when the queue exposes stats', async () => {
    const registerSpy = spyOn(healthMetrics, 'registerQueueStats');
    const provider = createProvider('whatsapp');
    const messageQueue = {
      enqueue: mock(() => {}),
      stop: mock(() => {}),
      getStats: mock(() => ({ totalRooms: 3, totalPending: 4, totalRunning: 1, stopped: false })),
    };
    const webhookServer = {
      registerSender: mock((_platform: string, _fn: RegisteredSender) => {}),
      start: mock(() => {}),
      stop: mock(() => {}),
    };
    const scheduler = {
      registerSender: mock((_platform: string, _fn: RegisteredSender) => {}),
      start: mock(() => {}),
      stop: mock(() => {}),
    };

    try {
      const runtime = new AppRuntime({
        providers: [provider],
        messageQueue,
        webhookServer,
        scheduler,
      });

      await runtime.start();

      expect(registerSpy).toHaveBeenCalledTimes(1);
      const getter = registerSpy.mock.calls[0]?.[0] as unknown as () => Record<string, unknown> | undefined;
      expect(getter?.()).toEqual({
        totalRooms: 3,
        totalPending: 4,
        totalRunning: 1,
        oldestPendingAgeMs: 0,
        droppedTasks: 0,
        stopped: false,
      });

      await runtime.stop();
    } finally {
      registerSpy.mockRestore();
    }
  });
});
