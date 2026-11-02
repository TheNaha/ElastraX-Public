/**
 * Verifies that the Scheduler routes a task-marked reminder to the agent task
 * runner instead of sending the literal text, and that it degrades to a normal
 * send when no runner is registered.
 *
 * This is the seam the whole feature depends on: if the Scheduler ever delivers
 * "/task …" verbatim again, scheduled runs silently become unreadable text.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { db } from '../src/db';
import { reminders, chatRooms } from '../src/db/schema';
import { Scheduler } from '../src/utils/Scheduler';

// Spread the real module and override only the target resolver: a bare
// mock.module would hide every other export other modules import.
const realRoomKeys = (await import('../src/messaging/roomKeys')) as typeof import('../src/messaging/roomKeys');
mock.module('../src/messaging/roomKeys', () => ({
  ...realRoomKeys,
  resolveReminderTarget: (reminder: any) => ({
    remoteRoomId: reminder.chatRoomId,
    roomKey: reminder.roomKey ?? `room:${reminder.platform}:${reminder.chatRoomId}`,
    mismatch: null as string | null,
    language: reminder.language ?? 'en',
  }),
}));

const ROOM = '1234567890@g.us';

async function seedReminder(overrides: any = {}): Promise<any> {
  const now = new Date(Date.now() - 1000); // 1 second ago (due)
  const reminder = {
    id: overrides.id ?? 1,
    chatRoomId: overrides.chatRoomId ?? ROOM,
    platform: overrides.platform ?? 'whatsapp',
    senderName: overrides.senderName ?? 'owner',
    message: overrides.message ?? 'plain reminder text',
    remindAt: overrides.remindAt ?? now,
    recurrence: overrides.recurrence ?? null,
    language: overrides.language ?? 'en',
    roomKey: overrides.roomKey ?? `room:whatsapp:${ROOM}`,
    created_at: new Date(),
    isSent: false,
    claimedAt: null,
  };
  await db.insert(reminders).values({
    chatRoomId: reminder.chatRoomId,
    senderId: 'user-1',
    senderName: reminder.senderName,
    message: reminder.message,
    remindAt: reminder.remindAt,
    isSent: false,
    claimedAt: null,
    platform: reminder.platform,
    recurrence: reminder.recurrence,
    language: reminder.language,
    roomKey: reminder.roomKey,
    created_at: reminder.created_at,
  });
  return reminder;
}

async function clearReminders(): Promise<void> {
  await db.delete(reminders);
}

const sent: Array<{ platform: string; chatId: string; text: string }> = [];
const taskRuns: Array<{ platform: string; remoteRoomId: string; roomKey: string; instruction: string; language: string }> = [];

beforeEach(async () => {
  await clearReminders();
  await seedChatRoom();
  sent.length = 0;
  taskRuns.length = 0;
  Scheduler.registerTaskRunner(null);
  Scheduler.registerSender('whatsapp', async (chatId: string, text: string) => {
    sent.push({ platform: 'whatsapp', chatId, text });
  });
});

async function seedChatRoom(): Promise<void> {
  await db.insert(chatRooms).values({
    id: ROOM,
    platform: 'whatsapp',
    language: 'en',
    roomKey: `room:whatsapp:${ROOM}`,
    created_at: new Date(),
  }).onConflictDoNothing();
}

afterEach(async () => {
  Scheduler.registerTaskRunner(null);
  Scheduler.unregisterSender('whatsapp');
  await clearReminders();
});

async function tick(): Promise<void> {
  await (Scheduler as unknown as { processReminders: () => Promise<void> }).processReminders();
}

describe('Scheduler agent task routing', () => {
  test('sends an ordinary reminder as text', async () => {
    await seedReminder();
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('plain reminder text');
    expect(taskRuns).toHaveLength(0);
  });

  test('runs a task-marked reminder through the agent instead of sending it', async () => {
    await seedReminder({ message: '/task summarise what changed today', recurrence: 'daily' });
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
    await seedReminder({ message: '/task summarise the day' });
    await tick();
    expect(taskRuns).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('/task summarise the day');
  });

  test('a bare marker with no instruction is sent as text', async () => {
    await seedReminder({ message: '/task' });
    Scheduler.registerTaskRunner(async () => {
      taskRuns.push({ platform: 'whatsapp', remoteRoomId: ROOM, roomKey: 'k', instruction: '', language: 'en' });
    });

    await tick();

    expect(taskRuns).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('/task');
  });

  test('a task-marked reminder for an unknown platform is retried, not sent', async () => {
    await seedReminder({ platform: 'unknown-platform', message: '/task summarise' });
    Scheduler.registerTaskRunner(async () => {
      taskRuns.push({ platform: 'unknown-platform', remoteRoomId: ROOM, roomKey: 'k', instruction: 'summarise', language: 'en' });
    });

    await tick();

    // No sender for unknown platform -> deferred/retried
    expect(sent).toHaveLength(0);
    expect(taskRuns).toHaveLength(0);
  });
});
