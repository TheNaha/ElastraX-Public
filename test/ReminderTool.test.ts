import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { db } from '../src/db';
import { reminders, chatRooms } from '../src/db/schema';
import { eq, and } from 'drizzle-orm';
import { ReminderTool, parseRelativeTime } from '../src/tools/ReminderTool';
import { MessageContext } from '../src/core/MessageContext';

const TEST_CHAT_ROOM_ID = 'chat-1';
const TEST_ROOM_KEY = 'room:whatsapp:chat-1';

async function seedRoom(): Promise<void> {
  await db.insert(chatRooms).values({
    id: TEST_CHAT_ROOM_ID,
    platform: 'whatsapp',
    language: 'en',
    roomKey: TEST_ROOM_KEY,
    created_at: new Date(),
  }).onConflictDoNothing();
}

async function clearReminders(): Promise<void> {
  await db.delete(reminders).where(eq(reminders.roomKey, TEST_ROOM_KEY));
}

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: TEST_CHAT_ROOM_ID,
  senderId: 'user-1',
  senderName: 'User',
  text: '',
  isGroup: false,
  isBotMentioned: false,
  hasMedia: false,
  language: 'en',
  messageType: 'conversation',
  messageId: 'msg-1',
  mediaReady: Promise.resolve(),
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  resolveRoles: mock(async () => ['user']),
  rawMessage: {},
  ...overrides,
} as MessageContext);

beforeEach(async () => {
  await clearReminders();
  await seedRoom();
});

afterEach(async () => {
  await clearReminders();
});

describe('ReminderTool', () => {
  const tool = new ReminderTool();

  test('basic properties', () => {
    expect(tool.name).toBe('reminder');
    expect(tool.aliases).toContain('remind');
    expect(tool.aliases).toContain('reminder');
    expect(tool.category).toBe('utility');
  });

  describe('parseRelativeTime', () => {
    test('"in 30 minutes" returns a Date ~30 min in future', () => {
      const now = Date.now();
      const result = parseRelativeTime('in 30 minutes');
      expect(result).toBeInstanceOf(Date);
      const diff = result!.getTime() - now;
      expect(diff).toBeGreaterThan(29 * 60_000);
      expect(diff).toBeLessThan(31 * 60_000);
    });

    test('"in 2 hours" returns a Date ~2h in future', () => {
      const now = Date.now();
      const result = parseRelativeTime('in 2 hours');
      expect(result).toBeInstanceOf(Date);
      const diff = result!.getTime() - now;
      expect(diff).toBeGreaterThan(119 * 60_000);
      expect(diff).toBeLessThan(121 * 60_000);
    });

    test('"in 1 day" returns a Date ~1d in future', () => {
      const now = Date.now();
      const result = parseRelativeTime('in 1 day');
      expect(result).toBeInstanceOf(Date);
      const diff = result!.getTime() - now;
      expect(diff).toBeGreaterThan(23 * 60 * 60_000);
      expect(diff).toBeLessThan(25 * 60 * 60_000);
    });

    test('"30 minutes" (without "in") also works', () => {
      const result = parseRelativeTime('30 minutes');
      expect(result).toBeInstanceOf(Date);
    });

    test('"5 seconds" returns ~5s in future', () => {
      const now = Date.now();
      const result = parseRelativeTime('5 seconds');
      expect(result).toBeInstanceOf(Date);
      const diff = result!.getTime() - now;
      expect(diff).toBeGreaterThan(4_000);
      expect(diff).toBeLessThan(6_000);
    });

    test('"tomorrow" returns date with 9:00 AM (default)', () => {
      const result = parseRelativeTime('tomorrow');
      expect(result).toBeInstanceOf(Date);
      expect(result!.getHours()).toBe(9);
      expect(result!.getMinutes()).toBe(0);
    });

    test('"tomorrow at 15:00" returns tomorrow at 3 PM', () => {
      const result = parseRelativeTime('tomorrow at 15:00');
      expect(result).toBeInstanceOf(Date);
      expect(result!.getHours()).toBe(15);
      expect(result!.getMinutes()).toBe(0);
    });

    test('"tomorrow at 3:00 pm" handles AM/PM', () => {
      const result = parseRelativeTime('tomorrow at 3:00 pm');
      expect(result).toBeInstanceOf(Date);
      expect(result!.getHours()).toBe(15);
    });

    test('"at 14:30" returns today or tomorrow at 14:30', () => {
      const result = parseRelativeTime('at 14:30');
      expect(result).toBeInstanceOf(Date);
      expect(result!.getHours()).toBe(14);
      expect(result!.getMinutes()).toBe(30);
    });

    test('"14:30" without "at" prefix also works', () => {
      const result = parseRelativeTime('14:30');
      expect(result).toBeInstanceOf(Date);
    });

    test('"at 18:00" from the tool description parses as 6 PM', () => {
      const result = parseRelativeTime('at 18:00');
      expect(result).toBeInstanceOf(Date);
      expect(result!.getHours()).toBe(18);
    });

    test('"tomorrow at 23:59" parses as just before midnight tomorrow', () => {
      const result = parseRelativeTime('tomorrow at 23:59');
      expect(result).toBeInstanceOf(Date);
      expect(result!.getHours()).toBe(23);
      expect(result!.getMinutes()).toBe(59);
    });

    test('rejects zero or negative delays', () => {
      expect(parseRelativeTime('in 0 seconds')).toBeNull();
    });

    test('rejects reminders beyond the five year horizon', () => {
      const result = parseRelativeTime('in 6 years');
      expect(result).toBeNull();
    });

    test('rejects 12-hour clock values that exceed 12', () => {
      const result = parseRelativeTime('tomorrow at 13:00 pm');
      expect(result).toBeNull();
    });

    test('invalid input returns null', () => {
      expect(parseRelativeTime('never')).toBeNull();
    });

    test('ISO date string within horizon works', () => {
      const result = parseRelativeTime('2027-12-31T23:59:00');
      expect(result).toBeInstanceOf(Date);
      expect(result!.getFullYear()).toBe(2027);
    });

    test('ISO date beyond five-year horizon returns null', () => {
      expect(parseRelativeTime('2099-12-31T23:59:00')).toBeNull();
    });

    test('ISO date in the past returns null', () => {
      expect(parseRelativeTime('2000-01-01T00:00:00')).toBeNull();
    });
  });

  test('action=list with no reminders returns list_empty', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'list' }, ctx);
    expect(result).toContain('no active reminders');
  });

  test('action=list with reminders returns formatted list', async () => {
    await db.insert(reminders).values({
      chatRoomId: TEST_CHAT_ROOM_ID,
      platform: 'whatsapp',
      roomKey: TEST_ROOM_KEY,
      senderId: 'user-1',
      senderName: 'User',
      message: 'Take medicine',
      remindAt: new Date('2025-01-01T10:00:00Z'),
      isSent: false,
      language: 'en',
      recurrence: null,
      created_at: new Date(),
    });
    await db.insert(reminders).values({
      chatRoomId: TEST_CHAT_ROOM_ID,
      platform: 'whatsapp',
      roomKey: TEST_ROOM_KEY,
      senderId: 'user-1',
      senderName: 'User',
      message: 'Meeting',
      remindAt: new Date('2025-01-02T14:00:00Z'),
      isSent: false,
      language: 'en',
      recurrence: 'daily',
      created_at: new Date(),
    });

    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'list' }, ctx);
    expect(result).toContain('Take medicine');
    expect(result).toContain('Meeting');
  });

  test('action=set with valid time and message inserts reminder', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'set', time: 'in 30 minutes', message: 'test reminder' }, ctx);
    expect(result).toContain('Reminder set');

    const rows = await db.select().from(reminders).where(eq(reminders.roomKey, TEST_ROOM_KEY));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe('test reminder');
  });

  test('action=set without time returns invalid_time', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'set', message: 'test' }, ctx);
    expect(result).toContain('Could not understand the time');
  });

  test('action=set without message returns no_message', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'set', time: 'in 30 minutes' }, ctx);
    expect(result).toContain('remind you about');
  });

  test('action=cancel with valid number deletes reminder', async () => {
    await db.insert(reminders).values({
      chatRoomId: TEST_CHAT_ROOM_ID,
      platform: 'whatsapp',
      roomKey: TEST_ROOM_KEY,
      senderId: 'user-1',
      senderName: 'User',
      message: 'Something',
      remindAt: new Date(),
      isSent: false,
      language: 'en',
      recurrence: null,
      created_at: new Date(),
    });

    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'cancel', number: '1' }, ctx);
    expect(result).toContain('cancelled');

    const rows = await db.select().from(reminders).where(eq(reminders.roomKey, TEST_ROOM_KEY));
    expect(rows).toHaveLength(0);
  });

  test('action=cancel with invalid number returns cancel_invalid', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'cancel', number: '0' }, ctx);
    expect(result).toContain('Invalid reminder number');
  });

  test('action=set with recurrence parameter inserts with recurrence', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'set', time: 'in 1 hour', message: 'recurring task', recurrence: 'daily' }, ctx);
    expect(result).toContain('daily');

    const rows = await db.select().from(reminders).where(eq(reminders.roomKey, TEST_ROOM_KEY));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recurrence).toBe('daily');
  });
});
