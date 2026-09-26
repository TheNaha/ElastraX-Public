/**
 * Verifies that the Scheduler routes a task-marked reminder to the agent task
 * runner instead of sending the literal text, and that it degrades to a normal
 * send when no runner is registered.
 *
 * This is the seam the whole feature depends on: if the Scheduler ever delivers
 * "/task …" verbatim again, scheduled runs silently become unreadable text.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

type ReminderRow = {
  id: number;
  chatRoomId: string;
  roomKey?: string | null;
  senderName: string;
  message: string;
  platform: string;
  remindAt: Date;
  recurrence: string | null;
  language?: string | null;
  anchorDay?: number | null;
};

let dueReminders: ReminderRow[] = [];
const sent: Array<{ platform: string; chatId: string; text: string }> = [];
const taskRuns: Array<{ platform: string; remoteRoomId: string; roomKey: string; instruction: string; language: string }> = [];

// Spread the real module so unrelated exports stay resolvable; only the query
// surface the scheduler uses is stubbed.
const realDatabaseModulePath: string = '../src/db/index.ts?case=scheduler-tasks';
const realDatabaseModule = (await import(realDatabaseModulePath)) as typeof import('../src/db');
mock.module('../src/db', () => ({
  ...realDatabaseModule,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ all: () => dueReminders }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          // The claim must succeed so the row is processed.
          run: () => ({ changes: 1 }),
        }),
        // `update().set()` without `.where()` is the recurring-rearm path.
        run: () => ({ changes: 1 }),
        values,
      }),
    }),
  },
}));

// Spread the real module and override only the target resolver: a bare
// mock.module would hide every other export other modules import.
const realRoomKeys = (await import('../src/messaging/roomKeys')) as typeof import('../src/messaging/roomKeys');
mock.module('../src/messaging/roomKeys', () => ({
  ...realRoomKeys,
  resolveReminderTarget: (reminder: ReminderRow) => ({
    remoteRoomId: reminder.chatRoomId,
    roomKey: reminder.roomKey ?? `room:${reminder.platform}:${reminder.chatRoomId}`,
    mismatch: null as string | null,
    language: reminder.language ?? 'en',
  }),
}));

const { Scheduler } = await import('../src/utils/Scheduler');

const ROOM = '1234567890@g.us';

function reminder(overrides: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: 1,
    chatRoomId: ROOM,
    roomKey: `room:whatsapp:${ROOM}`,
    senderName: 'owner',
    message: 'plain reminder text',
    platform: 'whatsapp',
    remindAt: new Date(Date.now() - 1000),
    recurrence: null,
    language: 'en',
    ...overrides,
  };
}

beforeEach(() => {
  dueReminders = [reminder()];
  sent.length = 0;
  taskRuns.length = 0;
  Scheduler.registerTaskRunner(null);
  Scheduler.registerSender('whatsapp', async (chatId: string, text: string) => {
    sent.push({ platform: 'whatsapp', chatId, text });
  });
});

afterEach(() => {
  Scheduler.registerTaskRunner(null);
  Scheduler.unregisterSender('whatsapp');
});

async function tick(): Promise<void> {
  await (Scheduler as unknown as { processReminders: () => Promise<void> })
    .processReminders();
}

describe('Scheduler agent task routing', () => {
  test('sends an ordinary reminder as text', async () => {
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('plain reminder text');
    expect(taskRuns).toHaveLength(0);
  });

  test('runs a task-marked reminder through the agent instead of sending it', async () => {
    dueReminders = [reminder({ message: '/task summarise what changed today', recurrence: 'daily' })];
    Scheduler.registerTaskRunner(async request => {
      taskRuns.push({
        platform: request.platform,
        remoteRoomId: request.remoteRoomId,
        roomKey: request.roomKey,
        instruction: request.instruction,
        language: request.language,
      });
    });

    await tick();

    expect(taskRuns).toHaveLength(1);
    // The marker is stripped and the room identity is passed through.
    expect(taskRuns[0]!.instruction).toBe('summarise what changed today');
    expect(taskRuns[0]!.remoteRoomId).toBe(ROOM);
    expect(taskRuns[0]!.roomKey).toBe(`room:whatsapp:${ROOM}`);
    // Nothing was sent as literal text.
    expect(sent).toHaveLength(0);
  });

  test('falls back to a literal send when no runner is registered', async () => {
    // Better that the user sees their text than that the message vanishes.
    dueReminders = [reminder({ message: '/task summarise the day' })];
    await tick();
    expect(taskRuns).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('/task summarise the day');
  });

  test('a bare marker with no instruction is sent as text', async () => {
    dueReminders = [reminder({ message: '/task' })];
    Scheduler.registerTaskRunner(async () => {
      taskRuns.push({ platform: 'whatsapp', remoteRoomId: ROOM, roomKey: 'k', instruction: '', language: 'en' });
    });
    await tick();
    expect(taskRuns).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  test('passes the reminder language through to the run', async () => {
    dueReminders = [reminder({ message: '/task ringkasan', language: 'id' })];
    Scheduler.registerTaskRunner(async request => {
      taskRuns.push({
        platform: request.platform,
        remoteRoomId: request.remoteRoomId,
        roomKey: request.roomKey,
        instruction: request.instruction,
        language: request.language,
      });
    });
    await tick();
    expect(taskRuns[0]!.language).toBe('id');
    expect(taskRuns[0]!.instruction).toBe('ringkasan');
  });

  test('a task run that throws is retried through the normal failure path', async () => {
    dueReminders = [reminder({ message: '/task do a thing' })];
    Scheduler.registerTaskRunner(async () => {
      throw new Error('model unavailable');
    });
    // Must not reject: the scheduler's own catch handles it.
    await tick();
    expect(sent).toHaveLength(0);
  });
});
