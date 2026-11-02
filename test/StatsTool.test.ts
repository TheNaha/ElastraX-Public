import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';
import { db } from '../src/db';
import { chatRooms, messages } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { StatsTool } from '../src/tools/StatsTool';

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

const TEST_CHAT_ROOM_ID = 'chat-1';
const TEST_ROOM_KEY = 'room:whatsapp:chat-1';
const BOT_SENDER_ID = 'bot-1';
const BOT_SENDER_NAME = 'Alice';

async function seedChatRoom(): Promise<void> {
  await db.insert(chatRooms).values({
    id: TEST_CHAT_ROOM_ID,
    platform: 'whatsapp',
    language: 'en',
    roomKey: TEST_ROOM_KEY,
    created_at: new Date(),
  });
}

async function insertTestMessage(
  overrides: {
    senderId?: string;
    senderName?: string;
    role?: 'user' | 'assistant';
    content?: string;
    roomKey?: string;
    chatRoomId?: string;
    createdAtSec?: number;
  } = {}
): Promise<void> {
  const {
    senderId = 'user-1',
    senderName = 'User',
    role = 'user',
    content = 'hello',
    roomKey = TEST_ROOM_KEY,
    chatRoomId = TEST_CHAT_ROOM_ID,
    createdAtSec = Math.floor(Date.now() / 1000),
  } = overrides;
  await db.insert(messages).values({
    chatRoomId,
    platform: 'whatsapp',
    roomKey,
    senderId,
    senderName,
    role,
    content,
    created_at: new Date(createdAtSec * 1000),
  });}

async function clearTestData(): Promise<void> {
  await db.delete(messages).where(eq(messages.roomKey, TEST_ROOM_KEY));
  await db.delete(chatRooms).where(eq(chatRooms.id, TEST_CHAT_ROOM_ID));
}

beforeEach(async () => {
  await clearTestData();
  await seedChatRoom();
});

afterEach(async () => {
  await clearTestData();
});

describe('StatsTool', () => {
  const tool = new StatsTool();

  test('basic properties', () => {
    expect(tool.name).toBe('room_stats');
    expect(tool.aliases).toContain('stats');
    expect(tool.aliases).toContain('statistics');
  });

  test('execute with no data returns no-data message', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({}, ctx);
    expect(result).toContain('No messages recorded');
  });

  test('execute with data returns formatted stats', async () => {
    // 100 total messages: 70 from user, 30 from assistant (Alice)
    for (let i = 0; i < 70; i++) {
      await insertTestMessage({
        senderId: 'user-1',
        senderName: 'User',
        role: 'user',
      });
    }
    for (let i = 0; i < 30; i++) {
      await insertTestMessage({
        senderId: BOT_SENDER_ID,
        senderName: BOT_SENDER_NAME,
        role: 'assistant',
      });
    }

    const ctx = createMockCtx();
    const result = await tool.execute({}, ctx);
    expect(result).toContain('100');
    expect(result).toContain('30');
    expect(result).toContain('User');
  });
});
