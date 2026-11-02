import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { db } from '../src/db';
import { chatRooms } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { MessageContext } from '../src/core/MessageContext';

type MockRoom = ReturnType<typeof defaultRoom>;

const TEST_CHAT_ROOM_ID = 'chat-abc';

const defaultRoom = () => ({
  id: TEST_CHAT_ROOM_ID,
  roomKey: 'room:whatsapp:chat-abc',
  platform: 'whatsapp',
  language: 'en',
  systemPrompt: null,
  contextLimit: null,
  temperature: null,
  maxTokens: null,
  allowTools: null,
  autoReplyAll: null,
  summarize: null,
  created_at: new Date(),
});

async function seedRoom(room: MockRoom): Promise<void> {
  await db.insert(chatRooms).values(room);
}

async function clearRoom(): Promise<void> {
  await db.delete(chatRooms).where(eq(chatRooms.id, TEST_CHAT_ROOM_ID));
}

const createCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: TEST_CHAT_ROOM_ID,
  senderId: 'user-1',
  senderName: 'Alice',
  text: '',
  isGroup: false,
  isBotMentioned: false,
  hasMedia: false,
  rawMessage: {},
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  ...overrides,
} as MessageContext);

import { ConfigTool } from '../src/tools/ConfigTool';

describe('ConfigTool Security', () => {
  let tool: ConfigTool;

  beforeEach(async () => {
    tool = new ConfigTool();
    await clearRoom();
    await seedRoom(defaultRoom());
  });

  test('Security: should reject huge contextLimit (DoS risk)', async () => {
    const result = await tool.execute(
      { action: 'set', key: 'contextLimit', value: '1000000' },
      createCtx(),
    );
    expect(result).toContain('Invalid value');
    expect(result).toContain('Must be between 1 and 50');
  });

  test('Security: should reject invalid temperature', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'temperature', value: '100' },
        createCtx(),
      );
      expect(result).toContain('Invalid value');
      expect(result).toContain('Must be a number between 0.0 and 2.0');
  });

  test('Security: should reject huge systemPrompt (DoS risk)', async () => {
    const hugePrompt = 'a'.repeat(51000); // > 50000 chars
    const result = await tool.execute(
      { action: 'set', key: 'systemPrompt', value: hugePrompt },
      createCtx(),
    );
    expect(result).toContain('Invalid value');
    expect(result).toContain('System prompt too long');
  });

  test('Security: should reject huge maxTokens (resource exhaustion risk)', async () => {
    const result = await tool.execute(
      { action: 'set', key: 'maxTokens', value: '9000' },
      createCtx(),
    );
    expect(result).toContain('Invalid value');
    expect(result).toContain('Must be between 64 and 8192');
  });
});
