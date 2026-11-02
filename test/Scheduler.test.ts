import { describe, test, expect, mock, afterEach, beforeEach, spyOn } from 'bun:test';
import { db } from '../src/db';
import { reminders, chatRooms } from '../src/db/schema';
import { eq, and, or, isNull, lte } from 'drizzle-orm';
import { Scheduler, computeNextOccurrence } from '../src/utils/Scheduler';

const TEST_CHAT_ROOM_ID = 'chat-1';
const TEST_ROOM_KEY = 'room:whatsapp:chat-1';

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
    id?: number;
    senderId?: string;
    senderName?: string;
    message?: string;
    platform?: string;
    remindAt?: Date;
    isSent?: boolean;
    claimedAt?: Date | null;
    recurrence?: string | null;
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
    language,
    roomKey,
    created_at: new Date(),
  });
  return Number((result as unknown as { lastInsertRowid: number }).lastInsertRowid);
}

async function clearReminders(): Promise<void> {
  await db.delete(reminders).where(eq(reminders.roomKey, TEST_ROOM_KEY));
}

async function countReminders(): Promise<number> {
  const rows = await db.select({ n: db.$count() }).from(reminders).where(eq(reminders.roomKey, TEST_ROOM_KEY));
  return rows[0]!.n;
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

  test('processReminders picks up due reminders', async () => {
    let senderCalled = false;
    Scheduler.registerSender('whatsapp', async () => {
      senderCalled = true;
    });

    await insertReminder({
      id: 1,
      message: 'take medicine',
      remindAt: new Date(Date.now() - 1000),
      isSent: false,
      claimedAt: null,
    });

    await Scheduler.processReminders();

    expect(senderCalled).toBe(true);
    const reminder = await getReminder(1);
    expect(reminder?.isSent).toBe(true);
    expect(reminder?.claimedAt).toBeNull();
  });

  test('processReminders does not pick up future reminders', async () => {
    let senderCalled = false;
    Scheduler.registerSender('whatsapp', async () => {
      senderCalled = true;
    });

    await insertReminder({
      id: 2,
      message: 'future reminder',
      remindAt: new Date(Date.now() + 86_400_000), // tomorrow
      isSent: false,
      claimedAt: null,
    });

    await Scheduler.processReminders();

    expect(senderCalled).toBe(false);
  });

  test('processReminders skips recently claimed reminders', async () => {
    let senderCalled = false;
    Scheduler.registerSender('whatsapp', async () => {
      senderCalled = true;
    });

    const staleCutoff = new Date(Date.now() - 5 * 60_000); // 5 minutes ago
    await insertReminder({
      id: 3,
      message: 'claimed reminder',
      remindAt: new Date(Date.now() - 1000),
      isSent: false,
      claimedAt: staleCutoff, // claimed but stale (old enough to retry)
    });

    await Scheduler.processReminders();

    expect(senderCalled).toBe(true);
  });

  test('processReminders does not retry non-stale claimed reminders', async () => {
    let senderCalled = false;
    Scheduler.registerSender('whatsapp', async () => {
      senderCalled = true;
    });

    const recentClaim = new Date(); // just claimed
    await insertReminder({
      id: 4,
      message: 'recently claimed',
      remindAt: new Date(Date.now() - 1000),
      isSent: false,
      claimedAt: recentClaim,
    });

    await Scheduler.processReminders();

    expect(senderCalled).toBe(false);
  });

  test('recurring reminder is rescheduled instead of marked sent', async () => {
    let senderCalled = false;
    Scheduler.registerSender('whatsapp', async () => {
      senderCalled = true;
    });

    const now = new Date();
    await insertReminder({
      id: 5,
      message: 'daily reminder',
      remindAt: now,
      isSent: false,
      claimedAt: null,
      recurrence: 'daily',
    });

    await Scheduler.processReminders();

    expect(senderCalled).toBe(true);
    const reminder = await getReminder(5);
    expect(reminder?.isSent).toBe(false); // recurring -> not sent
    expect(reminder?.claimedAt).toBeNull();
    expect(reminder?.recurrence).toBe('daily');
    // remindAt should be advanced to next occurrence
    expect(reminder!.remindAt.getTime()).toBeGreaterThan(now.getTime());
  });
});
