import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';
import { MenfessTool } from '../src/tools/MenfessTool';
import { SessionManager } from '../src/utils/SessionManager';

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

describe('MenfessTool', () => {
  const tool = new MenfessTool();
  let setSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setSpy = spyOn(SessionManager, 'set');
  });

  afterEach(() => {
    setSpy.mockRestore();
  });

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
    expect(setSpy).toHaveBeenCalled();
  });

  test('alias resolution works if MENFESS_TARGETS env is set', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ target: '628123@s.whatsapp.net', message: 'hello' }, ctx);
    expect(result).toContain('preview');
    expect(setSpy).toHaveBeenCalled();
  });
});
