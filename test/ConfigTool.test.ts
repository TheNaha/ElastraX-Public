import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';

// ── Mutable state captured by the db mock ────────────────────────────────────
let mockRoomRows: any[] = [];
let mockUpdateWhere = mock(async () => {});

mock.module('../src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => mockRoomRows,
      }),
    }),
    update: () => ({
      set: () => ({
        where: (...args: any[]) => mockUpdateWhere(...args),
      }),
    }),
  },
}));

const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

// Import AFTER mocks are set up
import { ConfigTool } from '../src/tools/ConfigTool';

// ── Helpers ───────────────────────────────────────────────────────────────────
const defaultRoom = () => ({
  id: 'chat-abc',
  platform: 'whatsapp',
  language: 'en',
  systemPrompt: null,
  contextLimit: null,
  temperature: null,
  allowTools: null,
  autoReplyAll: null,
  created_at: new Date(),
});

const createCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-abc',
  senderId: 'user-1',
  senderName: 'Alice',
  text: '',
  isGroup: false,
  hasMedia: false,
  rawMessage: {},
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  ...overrides,
});

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('ConfigTool', () => {
  let tool: ConfigTool;

  beforeEach(() => {
    tool = new ConfigTool();
    mockRoomRows = [defaultRoom()];
    mockUpdateWhere = mock(async () => {});
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
      expect(result).toContain('Context Limit');
      expect(result).toContain('Temperature');
    });

    test('should show [DEFAULT] labels when DB fields are null', async () => {
      const result = await tool.execute({ action: 'get' }, createCtx());
      expect(result).toContain('[DEFAULT');
    });

    test('should show [CUSTOM] for systemPrompt when DB has a custom value', async () => {
      mockRoomRows = [{ ...defaultRoom(), systemPrompt: 'My custom prompt' }];
      const result = await tool.execute({ action: 'get' }, createCtx());
      expect(result).toContain('[CUSTOM]');
    });

    test('should return error message when room does not exist', async () => {
      mockRoomRows = [];
      const result = await tool.execute({ action: 'get' }, createCtx());
      expect(result).toContain('Error');
    });
  });

  describe('set action', () => {
    test('should update systemPrompt', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'systemPrompt', value: 'You are a pirate.' },
        createCtx(),
      );
      expect(result).toContain('systemPrompt');
      expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    });

    test('should update contextLimit with a valid integer', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'contextLimit', value: '20' },
        createCtx(),
      );
      expect(result).toContain('contextLimit');
      expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    });

    test('should reject contextLimit with a non-numeric value', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'contextLimit', value: 'many' },
        createCtx(),
      );
      expect(result).toContain('Invalid value');
      expect(mockUpdateWhere).not.toHaveBeenCalled();
    });

    test('should update temperature with a valid float', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'temperature', value: '0.9' },
        createCtx(),
      );
      expect(result).toContain('temperature');
      expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    });

    test('should reject temperature with a non-numeric value', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'temperature', value: 'hot' },
        createCtx(),
      );
      expect(result).toContain('Invalid value');
      expect(mockUpdateWhere).not.toHaveBeenCalled();
    });

    test('should update allowTools to true with "true"', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'allowTools', value: 'true' },
        createCtx(),
      );
      expect(result).toContain('allowTools');
      expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    });

    test('should update allowTools to false with "false"', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'allowTools', value: 'false' },
        createCtx(),
      );
      expect(result).toContain('allowTools');
      expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    });

    test('should update allowTools with "1" (truthy alias)', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'allowTools', value: '1' },
        createCtx(),
      );
      expect(result).toContain('allowTools');
      expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    });

    test('should reject allowTools with an invalid boolean string', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'allowTools', value: 'yes' },
        createCtx(),
      );
      expect(result).toContain('Invalid value');
      expect(mockUpdateWhere).not.toHaveBeenCalled();
    });

    test('should update autoReplyAll', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'autoReplyAll', value: 'true' },
        createCtx(),
      );
      expect(result).toContain('autoReplyAll');
      expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    });

    test('should return error for an unknown key', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'unknownKey', value: 'value' },
        createCtx(),
      );
      expect(result).toContain('valid key');
      expect(mockUpdateWhere).not.toHaveBeenCalled();
    });

    test('should return error when key is missing', async () => {
      const result = await tool.execute({ action: 'set', value: 'something' }, createCtx());
      expect(result).toContain('valid key');
      expect(mockUpdateWhere).not.toHaveBeenCalled();
    });

    test('should return error when value is missing', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'systemPrompt' },
        createCtx(),
      );
      expect(result).toContain('value');
      expect(mockUpdateWhere).not.toHaveBeenCalled();
    });

    test('should return error when value is empty string', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'systemPrompt', value: '' },
        createCtx(),
      );
      expect(result).toContain('value');
      expect(mockUpdateWhere).not.toHaveBeenCalled();
    });
  });

  describe('reset action', () => {
    test('should reset a valid key to null (global default)', async () => {
      const result = await tool.execute(
        { action: 'reset', key: 'contextLimit' },
        createCtx(),
      );
      expect(result).toContain('contextLimit');
      expect(result).toContain('reset');
      expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    });

    test('should reset systemPrompt', async () => {
      const result = await tool.execute(
        { action: 'reset', key: 'systemPrompt' },
        createCtx(),
      );
      expect(result).toContain('systemPrompt');
      expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    });

    test('should reset temperature', async () => {
      const result = await tool.execute(
        { action: 'reset', key: 'temperature' },
        createCtx(),
      );
      expect(result).toContain('temperature');
      expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    });

    test('should return error for an invalid key on reset', async () => {
      const result = await tool.execute(
        { action: 'reset', key: 'notAValidKey' },
        createCtx(),
      );
      expect(result).toContain('valid key');
      expect(mockUpdateWhere).not.toHaveBeenCalled();
    });

    test('should return error when key is missing on reset', async () => {
      const result = await tool.execute({ action: 'reset' }, createCtx());
      expect(result).toContain('valid key');
      expect(mockUpdateWhere).not.toHaveBeenCalled();
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
