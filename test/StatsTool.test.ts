import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';
import { createTempDatabase, type TempDatabase } from './helpers/database';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

let mockSummaryRows: any[] = [];
let mockTopRows: any[] = [];

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
        where: () => {
          return {
            all: () => mockSummaryRows,
            groupBy: () => ({
              orderBy: () => ({
                limit: () => ({
                  all: () => mockTopRows,
                }),
              }),
            }),
          };
        },
      }),
    }),
  }),
  sqlite: database.sqlite,
  withImmediateTransaction,
}));

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

beforeEach(() => {
  mockSummaryRows = [];
  mockTopRows = [];
});

describe('StatsTool', () => {
  const tool = new StatsTool();

  test('basic properties', () => {
    expect(tool.name).toBe('room_stats');
    expect(tool.aliases).toContain('stats');
    expect(tool.aliases).toContain('statistics');
  });

  test('execute with no data (total=0) returns stats.no_data', async () => {
    mockSummaryRows = [{ total: 0, botReplies: 0, oldest: null }];
    const ctx = createMockCtx();
    const result = await tool.execute({}, ctx);
    expect(result).toContain('No messages recorded');
  });

  test('execute with data returns formatted stats', async () => {
    mockSummaryRows = [{ total: 100, botReplies: 30, oldest: new Date('2024-01-01') }];
    mockTopRows = [{ senderName: 'Alice', msgCount: 50 }];
    const ctx = createMockCtx();
    const result = await tool.execute({}, ctx);
    expect(result).toContain('100');
    expect(result).toContain('30');
    expect(result).toContain('Alice');
  });

  test('execute when DB throws returns error message', async () => {
    // Make the summary query throw by returning a proxy that throws on property access
    mockSummaryRows = [new Proxy({}, {
      get(_target, prop) {
        if (prop === 'total') throw new Error('DB read failed');
        return undefined;
      },
    })];
    const ctx = createMockCtx();
    const result = await tool.execute({}, ctx);
    expect(result).toContain('Failed to retrieve stats');
    expect(result).toContain('DB read failed');
  });
});
