import { describe, test, expect, mock, afterEach, beforeEach, spyOn } from 'bun:test';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

let dueReminders: Array<{
  id: number;
  chatRoomId: string;
  senderName: string;
  message: string;
  platform: string;
  remindAt: Date;
  recurrence: string | null;
}> = [];
const updateSets: Array<Record<string, unknown>> = [];
const updateRunCalls: number[] = [];
let nextClaimChanges = 1;

mock.module('../src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          all: () => dueReminders,
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updateSets.push(values);
        return {
        where: () => ({
            run: () => {
              updateRunCalls.push(1);
              return { changes: nextClaimChanges };
            },
          }),
        };
      },
    }),
  },
}));

import { Scheduler, computeNextOccurrence } from '../src/utils/Scheduler';

type SchedulerInternals = {
  computeNextOccurrence(lastFire: Date, recurrence: string): Date | null;
  processReminders(): Promise<void>;
};

const schedulerInternals = Scheduler as unknown as SchedulerInternals;

describe('Scheduler', () => {
  beforeEach(() => {
    Scheduler.stop();
    dueReminders = [];
    updateSets.length = 0;
    updateRunCalls.length = 0;
  });

  afterEach(() => {
    Scheduler.stop();
  });

  test('registerSender does not throw', () => {
    expect(() => Scheduler.registerSender('whatsapp', async () => {})).not.toThrow();
  });

  test('start does not throw', () => {
    expect(() => Scheduler.start()).not.toThrow();
  });

  test('start is idempotent (calling twice is safe)', () => {
    Scheduler.start();
    expect(() => Scheduler.start()).not.toThrow();
  });

  test('stop does not throw', () => {
    Scheduler.start();
    expect(() => Scheduler.stop()).not.toThrow();
  });

  test('stop is idempotent', () => {
    Scheduler.start();
    Scheduler.stop();
    expect(() => Scheduler.stop()).not.toThrow();
  });

  test('monthly recurrence should always return a future date', () => {
    const lastFire = new Date('2020-01-01T00:00:00.000Z');
    const next = computeNextOccurrence(lastFire, 'monthly');
    expect(next).not.toBeNull();
    if (!next) throw new Error('next should not be null');
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  test('invalid recurrence should return null', () => {
    const lastFire = new Date();
    const next = computeNextOccurrence(lastFire, 'every maybe');
    expect(next).toBeNull();
  });

  test('monthly recurrence preserves day-of-month without setMonth overflow drift', () => {
    // Anchor on Jan 31: naive setMonth arithmetic drifts Jan 31 -> Mar 3.
    const anchor = new Date();
    anchor.setMonth(0);
    anchor.setDate(31);
    anchor.setHours(12, 0, 0, 0);

    const next = computeNextOccurrence(anchor, 'monthly');
    expect(next).not.toBeNull();
    if (!next) throw new Error('next should not be null');
    expect(next.getTime()).toBeGreaterThan(Date.now());
    const daysInTargetMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    expect(next.getDate()).toBe(Math.min(31, daysInTargetMonth));
  });

  test('computeNextOccurrence handles hourly, daily, weekly, and every-unit recurrences', () => {
    const lastFire = new Date(Date.now() - 10 * 86_400_000);

    expect(computeNextOccurrence(lastFire, 'hourly')).toBeInstanceOf(Date);
    expect(computeNextOccurrence(lastFire, 'daily')).toBeInstanceOf(Date);
    expect(computeNextOccurrence(lastFire, 'weekly')).toBeInstanceOf(Date);
    expect(computeNextOccurrence(lastFire, 'every 30m')).toBeInstanceOf(Date);
    expect(computeNextOccurrence(lastFire, 'every 2h')).toBeInstanceOf(Date);
    expect(computeNextOccurrence(lastFire, 'every 7d')).toBeInstanceOf(Date);
    expect(computeNextOccurrence(lastFire, 'every 0h')).toBeNull();
  });

  test('processReminders returns early when nothing is due', async () => {
    await expect(schedulerInternals.processReminders()).resolves.toBeUndefined();
    expect(updateRunCalls).toHaveLength(0);
  });

  test('processReminders marks one-shot reminders as sent after delivery', async () => {
    const send = mock(async () => {});
    Scheduler.registerSender('whatsapp', send);
    dueReminders = [{
      id: 1,
      chatRoomId: 'chat-1',
      senderName: 'Alice',
      message: 'Standup',
      platform: 'whatsapp',
      remindAt: new Date(Date.now() - 1000),
      recurrence: null,
    }];

    await schedulerInternals.processReminders();

    expect(send).toHaveBeenCalledTimes(1);
    expect(updateSets).toContainEqual({ isSent: true });
  });

  test('processReminders reschedules recurring reminders when recurrence is valid', async () => {
    const send = mock(async () => {});
    Scheduler.registerSender('whatsapp', send);
    dueReminders = [{
      id: 2,
      chatRoomId: 'chat-2',
      senderName: 'Bob',
      message: 'Drink water',
      platform: 'whatsapp',
      remindAt: new Date(Date.now() - 60_000),
      recurrence: 'daily',
    }];

    await schedulerInternals.processReminders();

    expect(send).toHaveBeenCalledTimes(1);
    // First update is the claim, second is the reschedule (which releases the claim).
    expect(updateSets[0]?.claimedAt).toBeInstanceOf(Date);
    expect(updateSets[1]?.remindAt).toBeInstanceOf(Date);
    expect(updateSets[1]?.claimedAt).toBeNull();
  });

  test('processReminders marks recurring reminders as sent when recurrence is invalid', async () => {
    const send = mock(async () => {});
    Scheduler.registerSender('whatsapp', send);
    dueReminders = [{
      id: 3,
      chatRoomId: 'chat-3',
      senderName: 'Carol',
      message: 'Check logs',
      platform: 'whatsapp',
      remindAt: new Date(Date.now() - 60_000),
      recurrence: 'every maybe',
    }];

    await schedulerInternals.processReminders();

    expect(updateSets).toContainEqual({ isSent: true });
  });

  test('processReminders skips reminders when no sender exists for the platform', async () => {
    dueReminders = [{
      id: 4,
      chatRoomId: 'chat-4',
      senderName: 'Dana',
      message: 'Ping',
      platform: 'discord',
      remindAt: new Date(Date.now() - 60_000),
      recurrence: null,
    }];

    await schedulerInternals.processReminders();

    expect(updateRunCalls).toHaveLength(2); // claim + release
    expect(updateSets).toContainEqual({ claimedAt: null });
  });

  test('processReminders skips delivery when the atomic claim is already held', async () => {
    const send = mock(async () => {});
    Scheduler.registerSender('whatsapp', send);
    dueReminders = [{
      id: 4,
      chatRoomId: 'chat-4',
      senderName: 'Dana',
      message: 'Ping',
      platform: 'whatsapp',
      remindAt: new Date(Date.now() - 60_000),
      recurrence: null,
    }];

    nextClaimChanges = 0; // simulate a competing worker winning the claim
    try {
      await schedulerInternals.processReminders();
      expect(send).not.toHaveBeenCalled();
      expect(updateRunCalls).toHaveLength(1); // only the failed claim attempt
    } finally {
      nextClaimChanges = 1;
    }
  });

  test('processReminders swallows sender failures and continues', async () => {
    const send = mock(async (_chatId: string) => {
      throw new Error('send failed');
    });
    Scheduler.registerSender('whatsapp', send);
    dueReminders = [{
      id: 5,
      chatRoomId: 'chat-5',
      senderName: 'Eve',
      message: 'Alert',
      platform: 'whatsapp',
      remindAt: new Date(Date.now() - 60_000),
      recurrence: null,
    }];

    await expect(schedulerInternals.processReminders()).resolves.toBeUndefined();
    expect(updateRunCalls).toHaveLength(2); // claim + release for retry
    expect(updateSets).toContainEqual({ claimedAt: null });
  });

  test('start logs loop failures from the interval callback', async () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    let intervalCallback: (() => void) | null = null;
    const processSpy = spyOn(schedulerInternals, 'processReminders').mockRejectedValue(new Error('loop failed'));

    global.setInterval = (((callback: () => void) => {
      intervalCallback = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof global.setInterval);
    global.clearInterval = (((_handle: ReturnType<typeof setInterval>) => {}) as typeof global.clearInterval);

    try {
      Scheduler.start();
      (intervalCallback as (() => void) | null)?.();
      await Promise.resolve();
      expect(processSpy).toHaveBeenCalledTimes(1);
    } finally {
      Scheduler.stop();
      processSpy.mockRestore();
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    }
  });
});
