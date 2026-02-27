import { describe, test, expect, mock, beforeEach } from 'bun:test';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

let mockReminderRows: any[] = [];
let lastInsertedValues: any = null;
let lastDeletedId: any = null;

mock.module('../src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            all: () => mockReminderRows,
          }),
          all: () => mockReminderRows,
        }),
      }),
    }),
    insert: () => ({
      values: (vals: any) => ({
        run: () => { lastInsertedValues = vals; },
      }),
    }),
    delete: () => ({
      where: () => ({
        run: () => { lastDeletedId = true; },
      }),
    }),
  },
}));

import { parseRelativeTime, ReminderTool } from '../src/tools/ReminderTool';
import { MessageContext } from '../src/core/MessageContext';

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
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

beforeEach(() => {
  mockReminderRows = [];
  lastInsertedValues = null;
  lastDeletedId = null;
});

// ── parseRelativeTime ──────────────────────────────────────────────────────────

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
    expect(diff).toBeGreaterThan(23 * 3_600_000);
    expect(diff).toBeLessThan(25 * 3_600_000);
  });

  test('"30 minutes" (without "in") also works', () => {
    const now = Date.now();
    const result = parseRelativeTime('30 minutes');
    expect(result).toBeInstanceOf(Date);
    const diff = result!.getTime() - now;
    expect(diff).toBeGreaterThan(29 * 60_000);
    expect(diff).toBeLessThan(31 * 60_000);
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
    const now = new Date();
    const expected = new Date(now);
    expected.setDate(expected.getDate() + 1);
    expected.setHours(9, 0, 0, 0);
    expect(result!.getHours()).toBe(9);
    expect(result!.getMinutes()).toBe(0);
    expect(result!.getDate()).toBe(expected.getDate());
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
    expect(result!.getMinutes()).toBe(0);
  });

  test('"at 14:30" returns today or tomorrow at 14:30', () => {
    const result = parseRelativeTime('at 14:30');
    expect(result).toBeInstanceOf(Date);
    expect(result!.getHours()).toBe(14);
    expect(result!.getMinutes()).toBe(30);
    // Must be in the future
    expect(result!.getTime()).toBeGreaterThan(Date.now());
  });

  test('"14:30" without "at" prefix also works', () => {
    const result = parseRelativeTime('14:30');
    expect(result).toBeInstanceOf(Date);
    expect(result!.getHours()).toBe(14);
    expect(result!.getMinutes()).toBe(30);
  });

  test('invalid input returns null', () => {
    expect(parseRelativeTime('not a time')).toBeNull();
    expect(parseRelativeTime('')).toBeNull();
    expect(parseRelativeTime('blah blah')).toBeNull();
  });

  test('ISO date string in the future works', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const result = parseRelativeTime(future);
    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBeGreaterThan(Date.now());
  });

  test('ISO date in the past returns null', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(parseRelativeTime(past)).toBeNull();
  });
});

// ── ReminderTool ───────────────────────────────────────────────────────────────

describe('ReminderTool', () => {
  const tool = new ReminderTool();

  test('basic properties', () => {
    expect(tool.name).toBe('reminder');
    expect(tool.aliases).toContain('remind');
    expect(tool.aliases).toContain('reminder');
    expect(tool.category).toBe('utility');
  });

  test('action=list with no reminders returns list_empty', async () => {
    mockReminderRows = [];
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'list' }, ctx);
    expect(result).toContain('no active reminders');
  });

  test('action=list with reminders returns formatted list', async () => {
    mockReminderRows = [
      { id: 1, message: 'Take medicine', remindAt: new Date('2025-01-01T10:00:00'), recurrence: null },
      { id: 2, message: 'Meeting', remindAt: new Date('2025-01-02T14:00:00'), recurrence: 'daily' },
    ];
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'list' }, ctx);
    expect(result).toContain('Take medicine');
    expect(result).toContain('Meeting');
  });

  test('action=set with valid time and message inserts reminder', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'set', time: 'in 30 minutes', message: 'test reminder' }, ctx);
    expect(result).toContain('Reminder set');
    expect(lastInsertedValues).not.toBeNull();
    expect(lastInsertedValues.message).toBe('test reminder');
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
    mockReminderRows = [
      { id: 42, message: 'Something', remindAt: new Date(), recurrence: null },
    ];
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'cancel', number: '1' }, ctx);
    expect(result).toContain('cancelled');
    expect(lastDeletedId).toBe(true);
  });

  test('action=cancel with invalid number returns cancel_invalid', async () => {
    mockReminderRows = [];
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'cancel', number: '0' }, ctx);
    expect(result).toContain('Invalid reminder number');
  });

  test('action=set with recurrence parameter inserts with recurrence', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'set', time: 'in 1 hour', message: 'recurring task', recurrence: 'daily' }, ctx);
    expect(result).toContain('daily');
    expect(lastInsertedValues).not.toBeNull();
    expect(lastInsertedValues.recurrence).toBe('daily');
  });
});
