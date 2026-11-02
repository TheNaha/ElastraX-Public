import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';
import { db } from '../src/db';
import { chatRooms, messages, reminders, notificationSubscriptions } from '../src/db/schema';

async function seedRooms(rooms: { id: string; platform: string; language?: string }[]): Promise<void> {
  for (const room of rooms) {
    await db.insert(chatRooms).values({
      id: room.id,
      platform: room.platform,
      language: room.language ?? 'en',
      roomKey: `room:${room.platform}:${room.id}`,
      created_at: new Date(),
    }).onConflictDoNothing();
  }
}

async function clearRooms(): Promise<void> {
  // Delete dependent rows first to avoid FK constraint violations, then all rooms.
  await db.delete(messages).run();
  await db.delete(reminders).run();
  await db.delete(notificationSubscriptions).run();
  await db.delete(chatRooms).run();
}

import { OwnerTool } from '../src/tools/OwnerTool';

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
  resolveRoles: mock(async () => ['owner']),
  rawMessage: {},
  ...overrides,
} as MessageContext);

beforeEach(async () => {
  await clearRooms();
});

afterEach(async () => {
  await clearRooms();
});

describe('OwnerTool', () => {
  const tool = new OwnerTool();

  test('basic properties', () => {
    expect(tool.name).toBe('owner_admin');
    expect(tool.aliases).toContain('owner');
    expect(tool.aliases).toContain('broadcast');
    expect(tool.aliases).toContain('leave');
    expect(tool.aliases).toContain('botleave');
    expect(tool.permissions).toBe('owner');
  });

  test('action=broadcast without message returns broadcast_no_message', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'broadcast' }, ctx);
    expect(result).toContain('broadcast message');
  });

  test('action=broadcast with no rooms returns broadcast_no_rooms', async () => {
    await clearRooms();
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'broadcast', message: 'Hello' }, ctx);
    expect(result).toContain('No rooms found');
  });

  test('action=broadcast with rooms sends to each via forwardMessage', async () => {
    await seedRooms([
      { id: 'room-2', platform: 'whatsapp' },
      { id: 'room-3', platform: 'whatsapp' },
    ]);
    const mockForward = mock(async () => {});
    const ctx = createMockCtx({ forwardMessage: mockForward });
    const result = await tool.execute({ action: 'broadcast', message: 'Hello everyone' }, ctx);
    expect(result).toContain('Broadcast complete');
    expect(mockForward).toHaveBeenCalled();
  });

  test('action=leave when not in group returns leave_not_group', async () => {
    const ctx = createMockCtx({ isGroup: false });
    const result = await tool.execute({ action: 'leave' }, ctx);
    expect(result).toContain('only be used in a group');
  });

  test('action=leave in group calls leaveGroup', async () => {
    const mockLeave = mock(async () => {});
    const ctx = createMockCtx({ isGroup: true, leaveGroup: mockLeave });
    const result = await tool.execute({ action: 'leave' }, ctx);
    expect(mockLeave).toHaveBeenCalled();
    expect(result).toBe('');
  });

  test('action=leave without leaveGroup returns leave_not_supported', async () => {
    const ctx = createMockCtx({ isGroup: true });
    // Ensure leaveGroup is not set
    delete (ctx as any).leaveGroup;
    const result = await tool.execute({ action: 'leave' }, ctx);
    expect(result).toContain('not supported');
  });

  test('action=system_info returns system info text', async () => {
    await seedRooms([{ id: 'room-1', platform: 'whatsapp' }]);
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'system_info' }, ctx);
    expect(result).toContain('System Info');
    expect(result).toContain('Uptime');
    expect(result).toContain('Memory');
  });

  test('unknown action returns owner.usage', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'unknown_action' }, ctx);
    expect(result).toContain('Owner Commands');
  });
});
