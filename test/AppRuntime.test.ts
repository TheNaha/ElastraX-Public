import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import type { MessageContext } from '../src/core/MessageContext';
import type { BotProvider } from '../src/providers/BotProvider';
import type { AppRuntimeDeps } from '../src/runtime/AppRuntime';
import { AppRuntime, resolveMediaCleanupIntervalMs } from '../src/runtime/AppRuntime';
import { healthMetrics } from '../src/utils/HealthMetrics';

const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};

mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

type FakeTimerHandle = { id: string };
type RegisteredSender = (chatId: string, text: string) => Promise<void>;

type FakeProvider = BotProvider & {
  capturedHandler: ((ctx: MessageContext) => Promise<void>) | null;
  start: ReturnType<typeof mock>;
  stop: ReturnType<typeof mock>;
  sendMessage: ReturnType<typeof mock>;
};

function createProvider(name: BotProvider['name']): FakeProvider {
  return {
    name,
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
    const handleIncoming = mock(async () => {});
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
    expect(timers.setInterval).toHaveBeenCalledTimes(2);
    expect(timers.setTimeout).toHaveBeenCalledTimes(1);

    const ctx = {
      platform: 'whatsapp',
      chatId: 'room-1',
      senderId: 'user-1',
      senderName: 'Alice',
      text: 'hello',
      messageId: 'msg-1',
      messageType: 'conversation',
      isGroup: false,
      isBotMentioned: false,
      hasMedia: false,
      mediaReady: Promise.resolve(),
      rawMessage: {},
      reply: mock(async () => {}),
      checkPermissions: mock(async () => true),
      resolveRoles: mock(async () => ['user']),
    } satisfies MessageContext;

    await whatsappProvider.capturedHandler?.(ctx);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('room-1', expect.any(Function));
    expect(handleIncoming).toHaveBeenCalledWith(ctx);

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

    expect(timers.clearInterval).toHaveBeenCalledTimes(2);
    expect(timers.clearTimeout).toHaveBeenCalledTimes(1);
    expect(scheduler.stop).toHaveBeenCalledTimes(1);
    expect(webhookServer.stop).toHaveBeenCalledTimes(1);
    expect(messageQueue.stop).toHaveBeenCalledTimes(1);
    expect(provider.stop).toHaveBeenCalledTimes(1);
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
      getStats: mock(() => ({ totalRooms: 3, totalPending: 4, totalRunning: 1 })),
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
      const getter = registerSpy.mock.calls[0]?.[0];
      expect(getter?.()).toEqual({ totalRooms: 3, totalPending: 4, totalRunning: 1 });

      await runtime.stop();
    } finally {
      registerSpy.mockRestore();
    }
  });
});
