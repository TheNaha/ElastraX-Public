import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';

type MockRoom = ReturnType<typeof defaultRoom>;

function createMockUpdateWhere() {
  return mock(async (..._args: unknown[]) => {});
}

// ── Mutable state captured by the db mock ────────────────────────────────────
let mockRoomRows: MockRoom[] = [];
let mockUpdateWhere = createMockUpdateWhere();

mock.module('../src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => mockRoomRows,
      }),
    }),
    update: () => ({
      set: () => ({
        where: (...args: unknown[]) => mockUpdateWhere(...args),
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
  maxTokens: null,
  allowTools: null,
  autoReplyAll: null,
  summarize: null,
  created_at: new Date(),
});

const createCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-abc',
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

describe('ConfigTool Security', () => {
  let tool: ConfigTool;

  beforeEach(() => {
    tool = new ConfigTool();
    mockRoomRows = [defaultRoom()];
    mockUpdateWhere = createMockUpdateWhere();
  });

  test('Security: should reject huge contextLimit (DoS risk)', async () => {
    const result = await tool.execute(
      { action: 'set', key: 'contextLimit', value: '1000000' },
      createCtx(),
    );
    expect(result).toContain('Invalid value');
    expect(result).toContain('Must be between 1 and 50');
    expect(mockUpdateWhere).not.toHaveBeenCalled();
  });

  test('Security: should reject invalid temperature', async () => {
      const result = await tool.execute(
        { action: 'set', key: 'temperature', value: '100' },
        createCtx(),
      );
      expect(result).toContain('Invalid value');
      expect(result).toContain('Must be a number between 0.0 and 2.0');
      expect(mockUpdateWhere).not.toHaveBeenCalled();
  });

  test('Security: should reject huge systemPrompt (DoS risk)', async () => {
    const hugePrompt = 'a'.repeat(51000); // > 50000 chars
    const result = await tool.execute(
      { action: 'set', key: 'systemPrompt', value: hugePrompt },
      createCtx(),
    );
    expect(result).toContain('Invalid value');
    expect(result).toContain('System prompt too long');
    expect(mockUpdateWhere).not.toHaveBeenCalled();
  });

  test('Security: should reject huge maxTokens (resource exhaustion risk)', async () => {
    const result = await tool.execute(
      { action: 'set', key: 'maxTokens', value: '9000' },
      createCtx(),
    );
    expect(result).toContain('Invalid value');
    expect(result).toContain('Must be between 64 and 8192');
    expect(mockUpdateWhere).not.toHaveBeenCalled();
  });
});
