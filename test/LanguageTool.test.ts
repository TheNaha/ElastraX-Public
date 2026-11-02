import { expect, test, describe, mock, beforeEach, afterEach } from 'bun:test';
import { db } from '../src/db';
import { chatRooms } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { LanguageTool } from '../src/tools/LanguageTool';
import { MessageContext } from '../src/core/MessageContext';

const TEST_CHAT_ROOM_ID = 'chat-123';
const TEST_ROOM_KEY = 'room:whatsapp:chat-123';

async function seedRoom(language: string = 'en'): Promise<void> {
  await db.insert(chatRooms).values({
    id: TEST_CHAT_ROOM_ID,
    platform: 'whatsapp',
    language,
    roomKey: TEST_ROOM_KEY,
    created_at: new Date(),
  }).onConflictDoUpdate({ target: chatRooms.id, set: { language } });
}

async function clearRoom(): Promise<void> {
  await db.delete(chatRooms).where(eq(chatRooms.id, TEST_CHAT_ROOM_ID));
}

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: TEST_CHAT_ROOM_ID,
  senderId: 'user-456',
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

beforeEach(async () => {
  await clearRoom();
  await seedRoom();
});

afterEach(async () => {
  await clearRoom();
});

describe('LanguageTool', () => {
  test('should have correct name and metadata', () => {
    const tool = new LanguageTool();
    expect(tool.name).toBe('language');
    expect(tool.aliases).toContain('lang');
    expect(tool.aliases).toContain('setlanguage');
    expect(tool.aliases).toContain('setlang');
    expect(tool.category).toBe('settings');
    expect(tool.permissions).toBe('user');
  });

  test('definition should match OpenAI schema with enum', () => {
    const tool = new LanguageTool();
    const def = tool.definition;

    expect(def.type).toBe('function');
    expect(def.function.name).toBe('language');
    expect(def.function.parameters.required).toContain('lang_code');

    const langCodeProp = def.function.parameters.properties['lang_code'];
    expect(langCodeProp).toBeDefined();
    expect(langCodeProp.enum).toContain('en');
    expect(langCodeProp.enum).toContain('id');
  });

  test('should return error for missing lang_code', async () => {
    const tool = new LanguageTool();
    const ctx = createMockCtx();
    const result = await tool.execute({}, ctx);
    expect(result).toContain('Invalid language');
  });

  test('should return error for invalid lang_code', async () => {
    const tool = new LanguageTool();
    const ctx = createMockCtx();
    const result = await tool.execute({ lang_code: 'xx' as any }, ctx);
    expect(result).toContain('Invalid language');
  });

  test('should set language to en', async () => {
    const tool = new LanguageTool();
    const ctx = createMockCtx();
    const result = await tool.execute({ lang_code: 'en' }, ctx);
    expect(result).toContain('English');

    const rows = await db.select({ language: chatRooms.language }).from(chatRooms).where(eq(chatRooms.id, TEST_CHAT_ROOM_ID));
    expect(rows[0]?.language).toBe('en');
  });

  test('should set language to id', async () => {
    const tool = new LanguageTool();
    const ctx = createMockCtx();
    const result = await tool.execute({ lang_code: 'id' }, ctx);
    expect(result).toContain('Bahasa Indonesia');

    const rows = await db.select({ language: chatRooms.language }).from(chatRooms).where(eq(chatRooms.id, TEST_CHAT_ROOM_ID));
    expect(rows[0]?.language).toBe('id');
  });
});
