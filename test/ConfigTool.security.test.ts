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

mock.module('../src/utils/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

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

describe('ConfigTool Security', () => {
  let tool: ConfigTool;

  beforeEach(() => {
    tool = new ConfigTool();
    mockRoomRows = [defaultRoom()];
    mockUpdateWhere = mock(async () => {});
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
      expect(result).toContain('Must be between 0.0 and 2.0');
      expect(mockUpdateWhere).not.toHaveBeenCalled();
  });
});
