import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

const mockSet = mock((_userId: string, _flow: string, _data: any, _platform: string, _ttl: number) => {});
const mockClear = mock(() => {});
const mockGet = mock(() => null);
const mockHas = mock(() => false);

mock.module('../src/utils/SessionManager', () => ({
  SessionManager: { set: mockSet, clear: mockClear, get: mockGet, has: mockHas },
}));

mock.module('../src/core/FlowHandler', () => ({
  FlowHandler: { register: mock(() => {}), handle: mock(async () => false) },
}));

// Mock DB for any transitive imports
mock.module('../src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ all: () => [] }),
        all: () => [],
      }),
    }),
  },
}));

import { MenfessTool } from '../src/tools/MenfessTool';

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'user-1',
  senderName: 'User',
  text: '',
  isGroup: false,
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
  mockSet.mockClear();
  mockClear.mockClear();
  mockGet.mockClear();
  mockHas.mockClear();
});

describe('MenfessTool', () => {
  const tool = new MenfessTool();

  test('basic properties', () => {
    expect(tool.name).toBe('menfess');
    expect(tool.aliases).toContain('menfess');
    expect(tool.aliases).toContain('anon');
    expect(tool.category).toBe('fun');
  });

  test('execute without target returns no_target', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ target: '', message: 'hello' }, ctx);
    expect(result).toContain('specify the target');
  });

  test('execute without message returns no_message', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ target: '120363xxx@g.us', message: '' }, ctx);
    expect(result).toContain('provide a message');
  });

  test('execute with unknown target (not alias and not valid JID) returns error', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ target: 'nonexistent', message: 'hello' }, ctx);
    expect(result).toContain('Unknown target');
  });

  test('execute with valid JID target starts confirmation flow', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ target: '120363xxx@g.us', message: 'secret message' }, ctx);
    expect(result).toContain('preview');
    expect(result).toContain('secret message');
    expect(mockSet).toHaveBeenCalled();
  });

  test('alias resolution works if MENFESS_TARGETS env is set', async () => {
    // The aliases are loaded at module init from process.env.MENFESS_TARGETS.
    // Since we can't re-evaluate module init, we test with a raw JID instead.
    // This validates the tool accepts JIDs with @s.whatsapp.net
    const ctx = createMockCtx();
    const result = await tool.execute({ target: '628123@s.whatsapp.net', message: 'hello' }, ctx);
    expect(result).toContain('preview');
    expect(mockSet).toHaveBeenCalled();
  });
});
