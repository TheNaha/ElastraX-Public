import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { db } from '../src/db';
import { chatRooms } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { MessageContext } from '../src/core/MessageContext';
import { ConfigTool } from '../src/tools/ConfigTool';

type MockRoom = ReturnType<typeof defaultRoom>;

const TEST_CHAT_ROOM_ID = 'chat-abc';
const TEST_ROOM_KEY = 'room:whatsapp:chat-abc';

const defaultRoom = () => ({
  id: TEST_CHAT_ROOM_ID,
  roomKey: TEST_ROOM_KEY,
  platform: 'whatsapp',
  language: 'en',
  systemPrompt: null as string | null,
  contextLimit: null as number | null,
  temperature: null as number | null,
  maxTokens: null as number | null,
  allowTools: null as boolean | null,
  autoReplyAll: null as boolean | null,
  summarize: null as boolean | null,
  created_at: new Date(),
});

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

async function seedRoom(room: MockRoom): Promise<void> {
  await db.insert(chatRooms).values(room).onConflictDoUpdate({
    target: chatRooms.id,
    set: room,
  });
}

async function clearRoom(): Promise<void> {
  await db.delete(chatRooms).where(eq(chatRooms.id, TEST_CHAT_ROOM_ID));
}

async function getRoomValue(key: string): Promise<unknown> {
  const rows = await db.select().from(chatRooms).where(eq(chatRooms.id, TEST_CHAT_ROOM_ID));
  return (rows[0] as Record<string, unknown>)?.[key];
}

describe('ConfigTool', () => {
  let tool: ConfigTool;

  beforeEach(async () => {
    tool = new ConfigTool();
    await clearRoom();
    await seedRoom(defaultRoom());
  });

  afterEach(async () => {
    await clearRoom();
  });

  describe('metadata', () => {
    test('should have name "config"', () => {
      expect(tool.name).toBe('config');
    });

    test('should have aliases including "conf" and "settings"', () => {
      expect(tool.aliases).toContain('conf');
      expect(tool.aliases).toContain('settings');
    });

    test('should require admin permissions', () => {
      expect(tool.permissions).toBe('admin');
    });

    test('definition should list get, set, reset as valid actions', () => {
      const props = tool.definition.function.parameters.properties;
      expect(props.action.enum).toEqual(expect.arrayContaining(['get', 'set', 'reset']));
    });
  });

  describe('get action', () => {
    test('should return current config for the chat room', async () => {
      const result = await tool.execute({ action: 'get' }, createCtx());
      expect(result).toContain('chat-abc');
      expect(result).toContain('`contextLimit`');
      expect(result).toContain('`temperature`');
    });

    test('should show (Default) labels when DB fields are null', async () => {
      const result = await tool.execute({ action: 'get' }, createCtx());
      expect(result).toContain('(Default');
    });

    test('should show (Custom) for systemPrompt when DB has a custom value', async () => {
      await seedRoom({ ...defaultRoom(), systemPrompt: 'My custom prompt' });
      const result = await tool.execute({ action: 'get' }, createCtx());
      expect(result).toContain('(Custom)');
    });

    test('should return error message when room does not exist', async () => {
      await clearRoom();
      const result = await tool.execute({ action: 'get' }, createCtx());
      expect(result).toContain('not found');
    });
  });

  describe('set action', () => {
    test('should update systemPrompt', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'systemPrompt', value: 'You are a pirate.' },
        createCtx(),
      );
      expect(result).toContain('systemPrompt');
      expect(await getRoomValue('systemPrompt')).toBe('You are a pirate.');
    });

    test('should update contextLimit with a valid integer', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'contextLimit', value: '20' },
        createCtx(),
      );
      expect(result).toContain('contextLimit');
      expect(await getRoomValue('contextLimit')).toBe(20);
    });

    test('should reject contextLimit with a non-numeric value', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'contextLimit', value: 'many' },
        createCtx(),
      );
      expect(result).toContain('Invalid value');
      expect(await getRoomValue('contextLimit')).toBeNull();
    });

    test('should update temperature with a valid float', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'temperature', value: '0.9' },
        createCtx(),
      );
      expect(result).toContain('temperature');
      expect(await getRoomValue('temperature')).toBe(0.9);
    });

    test('should reject temperature with a non-numeric value', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'temperature', value: 'hot' },
        createCtx(),
      );
      expect(result).toContain('Invalid value');
      expect(await getRoomValue('temperature')).toBeNull();
    });

    test('should update allowTools to true with "true"', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'allowTools', value: 'true' },
        createCtx(),
      );
      expect(result).toContain('allowTools');
      expect(await getRoomValue('allowTools')).toBe(true);
    });

    test('should update allowTools to false with "false"', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'allowTools', value: 'false' },
        createCtx(),
      );
      expect(result).toContain('allowTools');
      expect(await getRoomValue('allowTools')).toBe(false);
    });

    test('should update allowTools with "1" (truthy alias)', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'allowTools', value: '1' },
        createCtx(),
      );
      expect(result).toContain('allowTools');
      expect(await getRoomValue('allowTools')).toBe(true);
    });

    test('should reject allowTools with an invalid boolean string', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'allowTools', value: 'yes' },
        createCtx(),
      );
      expect(result).toContain('Invalid value');
      expect(await getRoomValue('allowTools')).toBeNull();
    });

    test('should update autoReplyAll', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'autoReplyAll', value: 'true' },
        createCtx(),
      );
      expect(result).toContain('autoReplyAll');
      expect(await getRoomValue('autoReplyAll')).toBe(true);
    });

    test('should update maxTokens with a valid integer', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'maxTokens', value: '512' },
        createCtx(),
      );
      expect(result).toContain('maxTokens');
      expect(await getRoomValue('maxTokens')).toBe(512);
    });

    test('should reject maxTokens outside the allowed range', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'maxTokens', value: '32' },
        createCtx(),
      );
      expect(result).toContain('Invalid value');
      expect(await getRoomValue('maxTokens')).toBeNull();
    });

    test('should update summarize with boolean aliases', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'summarize', value: '0' },
        createCtx(),
      );
      expect(result).toContain('summarize');
      expect(await getRoomValue('summarize')).toBe(false);
    });

    test('should return error for an unknown key', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'unknownKey', value: 'value' },
        createCtx(),
      );
      expect(result).toContain('is not a valid configuration key');
    });

    test('should return suggestion for mistyped key in set action', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'contextLimt', value: '20' },
        createCtx(),
      );
      expect(result).toContain('Did you mean `contextLimit`?');
    });

    test('should return error when key is missing', async () => {
      const result = await tool.execute({ action: 'set', value: 'something' }, createCtx());
      expect(result).toContain('specify a configuration key');
    });

    test('should return suggestion for mistyped key in reset action', async () => {
      const result = await tool.execute(
        { action: 'reset', key: 'sytemPrompt' },
        createCtx(),
      );
      expect(result).toContain('Did you mean `systemPrompt`?');
    });

    test('should return error when value is missing', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'systemPrompt' },
        createCtx(),
      );
      expect(result).toContain('value');
    });

    test('should return error when value is empty string', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'systemPrompt', value: '' },
        createCtx(),
      );
      expect(result).toContain('value');
    });
  });

  describe('reset action', () => {
    test('should reset a valid key to null (global default)', async () => {
      await seedRoom({ ...defaultRoom(), contextLimit: 42 });
      const result = await tool.execute(
        { action: 'reset', key: 'contextLimit' },
        createCtx(),
      );
      expect(result).toContain('contextLimit');
      expect(result).toContain('reset');
      expect(await getRoomValue('contextLimit')).toBeNull();
    });

    test('should reset systemPrompt', async () => {
      await seedRoom({ ...defaultRoom(), systemPrompt: 'old prompt' });
      const result = await tool.execute(
        { action: 'reset', key: 'systemPrompt' },
        createCtx(),
      );
      expect(result).toContain('systemPrompt');
      expect(await getRoomValue('systemPrompt')).toBeNull();
    });

    test('should reset temperature', async () => {
      await seedRoom({ ...defaultRoom(), temperature: 0.7 });
      const result = await tool.execute(
        { action: 'reset', key: 'temperature' },
        createCtx(),
      );
      expect(result).toContain('temperature');
      expect(await getRoomValue('temperature')).toBeNull();
    });

    test('should return error for an invalid key on reset', async () => {
      const result = await tool.execute(
        { action: 'reset', key: 'notAValidKey' },
        createCtx(),
      );
      expect(result).toContain('is not a valid configuration key');
    });

    test('should return error when key is missing on reset', async () => {
      const result = await tool.execute({ action: 'reset' }, createCtx());
      expect(result).toContain('specify a configuration key');
    });
  });

  describe('unknown action', () => {
    test('should return usage instructions for an unknown action', async () => {
      const result = await tool.execute({ action: 'delete' }, createCtx());
      expect(result).toContain('Usage');
    });

    test('should return usage instructions when action is missing', async () => {
      const result = await tool.execute({}, createCtx());
      expect(result).toContain('Usage');
    });
  });
});
