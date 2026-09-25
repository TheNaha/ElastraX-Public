import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { FlowHandler } from '../src/core/FlowHandler';
import { MessageContext } from '../src/core/MessageContext';
import { MenfessTool, isMenfessTargetAllowed, loadTargetAliases, resolveTarget } from '../src/tools/MenfessTool';
import { withEnvironment } from './helpers/env';

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

describe('MenfessTool', () => {
  const tool = new MenfessTool();
  let setSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setSpy = spyOn(FlowHandler, 'setSession');
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
    const result = await tool.execute({ target: '120363000000000000@g.us', message: '' }, ctx);
    expect(result).toContain('provide a message');
  });

  test('execute with unknown target (not alias and not valid JID) returns error', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ target: 'nonexistent', message: 'hello' }, ctx);
    expect(result).toContain('Unknown target');
  });

  test('execute denies an arbitrary JID that is not on the allowlist', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ target: '120363000000000000@g.us', message: 'secret message' }, ctx);
    expect(result).toContain('Unknown target or non-allowlisted destination');
    expect(result).not.toContain('secret message');
    expect(setSpy).not.toHaveBeenCalled();
  });

  test('execute with an allowlisted JID target starts confirmation flow', async () => {
    const ctx = createMockCtx();
    await withEnvironment({ MENFESS_TARGETS: '120363000000000000@g.us,family:120363111111111111@g.us' }, async () => {
      const result = await tool.execute({ target: '120363000000000000@g.us', message: 'secret message' }, ctx);
      expect(result).toContain('preview');
      expect(result).toContain('secret message');
      expect(result).toContain('Anonymity is not guaranteed');
      expect(setSpy).toHaveBeenCalled();
    });
  });

  test('alias resolution works if MENFESS_TARGETS env is set', async () => {
    const ctx = createMockCtx();
    await withEnvironment({ MENFESS_TARGETS: 'family:120363111111111111@g.us' }, async () => {
      const result = await tool.execute({ target: 'family', message: 'hello' }, ctx);
      expect(result).toContain('preview');
      expect(setSpy).toHaveBeenCalled();
    });
  });

  test('rejects oversized messages before starting a flow', async () => {
    const ctx = createMockCtx();
    await withEnvironment({ MENFESS_TARGETS: 'family:120363111111111111@g.us' }, async () => {
      const result = await tool.execute({ target: 'family', message: 'a'.repeat(4_001) }, ctx);
      expect(result).toContain('limited to 4000 characters');
      expect(setSpy).not.toHaveBeenCalled();
    });
  });

  test('allowlist helpers ignore malformed entries and unlisted destinations', async () => {
    await withEnvironment({ MENFESS_TARGETS: 'family:120363111111111111@g.us,  ,:orphan,broken:,120363000000000000@g.us' }, () => {
      const aliases = loadTargetAliases();
      expect(aliases.has('family')).toBe(true);
      expect(aliases.has('120363000000000000@g.us')).toBe(true);
      expect(aliases.has('broken')).toBe(false);
      expect(aliases.has('orphan')).toBe(false);

      expect(isMenfessTargetAllowed('family')).toBe(true);
      expect(isMenfessTargetAllowed('FAMILY')).toBe(true);
      expect(isMenfessTargetAllowed('120363000000000000@g.us')).toBe(true);
      expect(isMenfessTargetAllowed('someone@s.whatsapp.net')).toBe(false);
      expect(isMenfessTargetAllowed('other-group@g.us')).toBe(false);
      expect(resolveTarget('other-group@g.us')).toBeNull();
    });
  });

  test('with no MENFESS_TARGETS configured every destination is denied', async () => {
    await withEnvironment({ MENFESS_TARGETS: undefined }, () => {
      expect(loadTargetAliases().size).toBe(0);
      expect(isMenfessTargetAllowed('family')).toBe(false);
      expect(isMenfessTargetAllowed('120363000000000000@g.us')).toBe(false);
    });
  });
});
