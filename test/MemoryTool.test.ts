import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

let configEnabled = true;
let dupResult: { id: string; content: string; similarity: number } | null = null;
let embedCalls: string[] = [];

mock.module('../src/utils/semanticMemory', () => ({
  findSemanticDuplicate: mock(async (_ownerId: string, content: string) => {
    embedCalls.push(`dedupe:${content}`);
    return dupResult;
  }),
  updateMemoryEmbedding: mock(async (id: string, content: string) => {
    embedCalls.push(`embed:${id}:${content}`);
    return true;
  }),
}));

let roomRow: Record<string, unknown> | null = { id: 'chat-1', longTermMemory: 1 };
let memRows: { id: string; content: string }[] = [];
let insertCalls: Record<string, unknown>[] = [];
let deletedRows: { id: string; ownerId: string }[] = [];

// Route queries by REAL table identity — no schema mock needed (schema.ts is
// side-effect-free), which keeps this file from polluting shared workers.
import { chatRooms as chatRoomsTable, memories as memoriesTable } from '../src/db/schema';

mock.module('../src/utils/ConfigService', () => ({
  ConfigService: {
    getResolvedConfig: () => ({ longTermMemory: configEnabled }),
  },
}));

mock.module('../src/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const isRooms = table === chatRoomsTable;
        return {
          where: () => ({
            orderBy: () => ({
              limit: async () => (isRooms ? [] : memRows),
            }),
            then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
              Promise.resolve(isRooms ? (roomRow ? [roomRow] : []) : []).then(onFulfilled, onRejected),
          }),
        };
      },
    }),
    insert: () => ({
      values: async (vals: Record<string, unknown>) => {
        insertCalls.push(vals);
      },
    }),
    delete: () => ({
      where: () => ({
        returning: async () => deletedRows,
      }),
    }),
  },
}));

import { MemoryTool } from '../src/tools/MemoryTool';

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
  configEnabled = true;
  dupResult = null;
  embedCalls = [];
  roomRow = { id: 'chat-1', longTermMemory: 1 };
  memRows = [];
  insertCalls = [];
  deletedRows = [];
});

describe('MemoryTool semantic dedupe integration', () => {
  const tool = new MemoryTool();

  test('store suppresses near-identical memory and skips insert', async () => {
    dupResult = { id: 'dup1', content: 'the wifi password is hunter2', similarity: 0.97 };
    const result = await tool.execute({ action: 'store', content: 'wifi password is hunter2' }, createMockCtx());
    expect(result).toBe('Already remembered [dup1]: the wifi password is hunter2');
    expect(insertCalls).toHaveLength(0);
    // Only the dedupe lookup ran; no post-insert embedding either.
    expect(embedCalls).toEqual(['dedupe:wifi password is hunter2']);
  });

  test('store inserts and best-effort embeds when no duplicate', async () => {
    const result = await tool.execute({ action: 'store', content: 'likes pineapple pizza' }, createMockCtx());
    expect(result).toContain('Stored memory [');
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]!.ownerId).toBe('user-1');
    expect(insertCalls[0]!.content).toBe('likes pineapple pizza');
    const embedCall = embedCalls.find(c => c.startsWith('embed:'));
    expect(embedCall).toBeDefined();
    expect(embedCall).toContain(':likes pineapple pizza');
  });

  test('group store uses the room as owner', async () => {
    await tool.execute({ action: 'store', content: 'group fact' }, createMockCtx({ isGroup: true }));
    expect(insertCalls[0]!.ownerId).toBe('chat-1');
  });

  test('retrieve lists capped memories with ids', async () => {
    memRows = [
      { id: 'aaa', content: 'first' },
      { id: 'bbb', content: 'second' },
    ];
    const result = await tool.execute({ action: 'retrieve' }, createMockCtx());
    expect(result).toContain('[aaa] first');
    expect(result).toContain('[bbb] second');
  });

  test('forget deletes own memory by id', async () => {
    deletedRows = [{ id: 'xyz', ownerId: 'user-1' }];
    const result = await tool.execute({ action: 'forget', id: 'xyz' }, createMockCtx());
    expect(result).toBe('Forgot memory xyz');
  });

  test('forget reports missing memory', async () => {
    deletedRows = [];
    const result = await tool.execute({ action: 'forget', id: 'nope' }, createMockCtx());
    expect(result).toBe('Error: Memory ID nope not found.');
  });

  test('disabled long-term memory short-circuits before any DB work', async () => {
    configEnabled = false;
    const result = await tool.execute({ action: 'store', content: 'x' }, createMockCtx());
    expect(result).toContain('Long-term memory is currently disabled');
    expect(embedCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });
});
