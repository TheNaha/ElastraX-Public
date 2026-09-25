import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createTempDatabase, type TempDatabase } from './helpers/database';
import { MessageContext } from '../src/core/MessageContext';

type MockRoom = ReturnType<typeof defaultRoom>;

function createMockUpdateWhere() {
  return mock(async (..._args: unknown[]) => {});
}

// ── Mutable state captured by the db mock ────────────────────────────────────
let mockRoomRows: MockRoom[] = [];
let mockUpdateWhere = createMockUpdateWhere();

// ── Module mock backed by a real migrated temp database ──────────────────────
// Bun module mocks are process-wide, so this fake must expose the full
// `../src/db` surface or every other test file importing the real module breaks.
const database: TempDatabase = createTempDatabase();

// Mirrors src/db/runtime.ts exactly: the return value must be propagated,
// because callers such as claimInboxEvents rely on it.
function withImmediateTransaction<T>(sqlite: TempDatabase['sqlite'], operation: () => T): T {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      sqlite.exec('ROLLBACK');
    } catch {
      // The transaction may already be rolled back; surface the original error.
    }
    throw error;
  }
}

function completeDb(overrides: Record<string, unknown>): unknown {
  const base = database.db as unknown as Record<string | symbol, unknown>;
  return new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === 'string' && property in overrides) return overrides[property];
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

mock.module('../src/db', () => ({
  db: completeDb({
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
  }),
  sqlite: database.sqlite,
  withImmediateTransaction,
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
