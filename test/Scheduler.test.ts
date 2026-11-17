import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { db } from '../src/db';
import { reminders, chatRooms } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { Scheduler, computeNextOccurrence, isValidRecurrence } from '../src/utils/Scheduler';

const TEST_CHAT_ROOM_ID = 'scheduler-chat-1';
const TEST_ROOM_KEY = 'room:whatsapp:scheduler-chat-1';

async function seedChatRoom(): Promise<void> {
  await db.insert(chatRooms).values({
    id: TEST_CHAT_ROOM_ID,
    platform: 'whatsapp',
    language: 'en',
    roomKey: TEST_ROOM_KEY,
    created_at: new Date(),
  }).onConflictDoNothing();
}

async function insertReminder(
  overrides: {
    senderId?: string;
    senderName?: string;
    message?: string;
    platform?: string;
    remindAt?: Date;
    isSent?: boolean;
    claimedAt?: Date | null;
    recurrence?: string | null;
    anchorDay?: number | null;
    language?: string;
    roomKey?: string;
    chatRoomId?: string;
  } = {}
): Promise<number> {
  const {
    senderId = 'user-1',
    senderName = 'User',
    message = 'test reminder',
    platform = 'whatsapp',
    remindAt = new Date(Date.now() - 60_000), // 1 minute ago (due)
    isSent = false,
    claimedAt = null,
    recurrence = null,
    anchorDay = null,
    language = 'en',
    roomKey = TEST_ROOM_KEY,
    chatRoomId = TEST_CHAT_ROOM_ID,
  } = overrides;
  const result = await db.insert(reminders).values({
    chatRoomId,
    senderId,
    senderName,
    message,
    remindAt,
    isSent,
    claimedAt,
    platform,
    recurrence,
    anchorDay,
    language,
    roomKey,
    created_at: new Date(),
  });
  return Number((result as unknown as { lastInsertRowid: number }).lastInsertRowid);
}

async function clearReminders(): Promise<void> {
  await db.delete(reminders).where(eq(reminders.roomKey, TEST_ROOM_KEY));
}

async function getReminder(id: number) {
  const rows = await db.select().from(reminders).where(eq(reminders.id, id));
  return rows[0];
}

type SchedulerInternals = {
  stopped: boolean;
  processing: boolean;
  computeNextOccurrence(lastFire: Date, recurrence: string): Date | null;
  processReminders(): Promise<void>;
  timer: ReturnType<typeof setInterval> | null;
};

const schedulerInternals = Scheduler as unknown as SchedulerInternals;

describe('Scheduler', () => {
  beforeEach(async () => {
    Scheduler.stop();
    schedulerInternals.stopped = false;
    schedulerInternals.processing = false;
    await clearReminders();
    await seedChatRoom();
  });

  afterEach(() => {
    Scheduler.stop();
  });

  test('registerSender does not throw', () => {
    Scheduler.registerSender('whatsapp', async () => {});
  });

  test('computeNextOccurrence', () => {
    const base = new Date('2026-01-01T10:00:00Z');
    const next = computeNextOccurrence(base, 'daily');
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(base.getTime());
  });

  // `every N days` used to add a fixed millisecond count while `daily`/`weekly`
  // rebuilt the date from local components, so a DST change moved `every 1 day`
  // by an hour permanently. Both cadences must agree.
  test('every N days keeps the local wall-clock time like daily', () => {
    // Pinned to a DST-observing zone so the regression is caught everywhere,
    // not only on a machine that happens to live in one.
    const previousTz = process.env.TZ;
    process.env.TZ = 'Europe/Berlin';
    try {
      // A January base and a July "now": the catch-up crosses the March
      // transition, so a fixed-millisecond step lands at 10:30 local while the
      // calendar step stays at 09:30.
      const base = new Date(2026, 0, 1, 9, 30, 0, 0); // 09:30 CET
      const now = new Date(2026, 6, 1, 12, 0, 0, 0).getTime(); // July, CEST
      const daily = computeNextOccurrence(base, 'daily', base.getDate(), now)!;
      const every = computeNextOccurrence(base, 'every 1 day', base.getDate(), now)!;
      expect(every.getTime()).toBe(daily.getTime());
      expect(daily.getHours()).toBe(9);
      expect(daily.getMinutes()).toBe(30);
      expect(daily.getTime()).toBeGreaterThan(now);
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });

  // The catch-up loop is capped at MAX_CATCHUP_STEPS periods. A reminder left
  // unfired for longer than that used to return a date that was still in the
  // past, so processReminders wrote it back and fired again on the next tick.
  // The day special-case must not skip the interval bounds: an absurd interval
  // used to reach isValidRecurrence, and an interval large enough to overflow
  // the Date range produced an Invalid Date that `if (!nextFire)` accepts.
  test('an out-of-range day interval is rejected', () => {
    expect(computeNextOccurrence(new Date(), 'every 100000 days')).toBeNull();
    expect(computeNextOccurrence(new Date(), 'every 1000000000 days')).toBeNull();
    expect(isValidRecurrence('every 100000 days')).toBe(false);
    expect(isValidRecurrence('every 1000000000 days')).toBe(false);
    expect(isValidRecurrence('every 1 day')).toBe(true);
  });

  test('a reminder far behind the catch-up cap still lands in the future', () => {
    const base = new Date(2024, 0, 1, 9, 0, 0, 0);
    for (const recurrence of ['daily', 'weekly', 'every 3 days']) {
      const next = computeNextOccurrence(base, recurrence);
      expect(next).not.toBeNull();
      expect(next!.getTime()).toBeGreaterThan(Date.now());
    }
  });

  test('processReminders picks up due reminders', async () => {
    let senderCalled = false;
    Scheduler.registerSender('whatsapp', async () => {
      senderCalled = true;
    });

    const id = await insertReminder({
      message: 'take medicine',
      remindAt: new Date(Date.now() - 1000),
      isSent: false,
      claimedAt: null,
    });

    await schedulerInternals.processReminders();

    expect(senderCalled).toBe(true);
    const reminder = await getReminder(id);
    expect(reminder?.isSent).toBe(true);
    expect(reminder?.claimedAt).toBeNull();
  });

  test('processReminders does not pick up future reminders', async () => {
    let senderCalled = false;
    Scheduler.registerSender('whatsapp', async () => {
      senderCalled = true;
    });

    await insertReminder({
      message: 'future reminder',
      remindAt: new Date(Date.now() + 86_400_000), // tomorrow
      isSent: false,
      claimedAt: null,
    });

    await schedulerInternals.processReminders();

    expect(senderCalled).toBe(false);
  });

  test('processReminders skips recently claimed reminders', async () => {
    let senderCalled = false;
    Scheduler.registerSender('whatsapp', async () => {
      senderCalled = true;
    });

    const staleCutoff = new Date(Date.now() - 5 * 60_000); // 5 minutes ago
    await insertReminder({
      message: 'claimed reminder',
      remindAt: new Date(Date.now() - 1000),
      isSent: false,
      claimedAt: staleCutoff, // claimed but stale (old enough to retry)
    });

    await schedulerInternals.processReminders();

    expect(senderCalled).toBe(true);
  });

  test('processReminders does not retry non-stale claimed reminders', async () => {
    let senderCalled = false;
    Scheduler.registerSender('whatsapp', async () => {
      senderCalled = true;
    });

    const recentClaim = new Date(); // just claimed
    await insertReminder({
      message: 'recently claimed',
      remindAt: new Date(Date.now() - 1000),
      isSent: false,
      claimedAt: recentClaim,
    });

    await schedulerInternals.processReminders();

    expect(senderCalled).toBe(false);
  });

  test('recurring reminder is rescheduled instead of marked sent', async () => {
    let senderCalled = false;
    Scheduler.registerSender('whatsapp', async () => {
      senderCalled = true;
    });

    const now = new Date();
    const id = await insertReminder({
      message: 'daily reminder',
      remindAt: now,
      isSent: false,
      claimedAt: null,
      recurrence: 'daily',
    });

    await schedulerInternals.processReminders();

    expect(senderCalled).toBe(true);
    const reminder = await getReminder(id);
    expect(reminder?.isSent).toBe(false); // recurring -> not sent
    expect(reminder?.claimedAt).toBeNull();
    expect(reminder?.recurrence).toBe('daily');
    // remindAt should be advanced to next occurrence
    expect(reminder!.remindAt.getTime()).toBeGreaterThan(now.getTime());
  });

  test('a monthly reminder recurs on its stored anchor day, not the creation day', async () => {
    let senderCalled = false;
    Scheduler.registerSender('whatsapp', async () => {
      senderCalled = true;
    });

    // Created today (17th) for a first fire that is not on the 17th; the user
    // chose the 15th. Deriving the anchor from `created_at` moved the cadence to
    // the 17th of every later month.
    const id = await insertReminder({
      message: 'monthly reminder',
      remindAt: new Date(Date.now() - 60_000),
      isSent: false,
      claimedAt: null,
      recurrence: 'monthly',
      anchorDay: 15,
    });

    await schedulerInternals.processReminders();

    expect(senderCalled).toBe(true);
    const reminder = await getReminder(id);
    expect(reminder?.isSent).toBe(false);
    expect(reminder!.remindAt.getDate()).toBe(15);
    expect(reminder!.remindAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('a deferral preserves a recurring reminder\'s schedule anchor', async () => {
    // No sender for this platform: delivery cannot even be attempted.
    Scheduler.unregisterSender('whatsapp');
    const anchor = new Date(Date.now() - 60 * 60_000);
    const id = await insertReminder({
      message: 'daily reminder',
      remindAt: anchor,
      isSent: false,
      claimedAt: null,
      recurrence: 'daily',
    });

    await schedulerInternals.processReminders();

    const reminder = await getReminder(id);
    // Still pending, not retired on the first failure.
    expect(reminder?.isSent).toBe(false);
    // The recurrence anchor must not move to the retry time. Stored timestamps
    // are second-precision, so compare on that scale.
    expect(Math.floor(reminder!.remindAt.getTime() / 1000)).toBe(Math.floor(anchor.getTime() / 1000));
    // The claim is held until the backoff expires, which paces the retry.
    expect(reminder?.claimedAt).not.toBeNull();
    expect(reminder!.claimedAt!.getTime()).toBeGreaterThan(Date.now());
  });

  test('a deferral moves a one-shot reminder forward instead of re-firing every tick', async () => {
    Scheduler.unregisterSender('whatsapp');
    const id = await insertReminder({
      message: 'one shot',
      remindAt: new Date(Date.now() - 60_000),
      isSent: false,
      claimedAt: null,
    });

    await schedulerInternals.processReminders();

    const reminder = await getReminder(id);
    expect(reminder?.isSent).toBe(false);
    // No recurrence anchor to protect: remindAt is pushed into the future so the
    // row is not immediately due again on the next tick.
    expect(reminder!.remindAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('repeated deferrals never retire a recurring reminder', async () => {
    const internals = Scheduler as unknown as {
      deferOrRetire(reminder: { id: number; recurrence: string | null }, reason: string): void;
    };
    const id = await insertReminder({
      message: 'daily reminder',
      remindAt: new Date(Date.now() - 60_000),
      isSent: false,
      claimedAt: null,
      recurrence: 'daily',
    });

    for (let i = 0; i < 30; i++) internals.deferOrRetire({ id, recurrence: 'daily' }, 'no sender');

    const reminder = await getReminder(id);
    // The next occurrence is the retry, so a long outage must not delete it.
    expect(reminder?.isSent).toBe(false);
  });

  test('a one-shot reminder is retired once the deferral cap is reached', async () => {
    const internals = Scheduler as unknown as {
      deferOrRetire(reminder: { id: number; recurrence: string | null }, reason: string): void;
    };
    const id = await insertReminder({
      message: 'one shot',
      remindAt: new Date(Date.now() - 60_000),
      isSent: false,
      claimedAt: null,
    });

    // MAX_DEFER_ATTEMPTS is 24; drive past it.
    for (let i = 0; i < 25; i++) internals.deferOrRetire({ id, recurrence: null }, 'no sender');

    const reminder = await getReminder(id);
    expect(reminder?.isSent).toBe(true);
  });
});
