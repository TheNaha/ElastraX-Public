import { expect, test, describe, beforeEach, mock } from 'bun:test';
import { FlowHandler } from '../src/core/FlowHandler';
import { SessionManager } from '../src/utils/SessionManager';
import { MessageContext } from '../src/core/MessageContext';

// Suppress logger output
mock.module('../src/utils/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-123',
  senderId: 'user-456',
  senderName: 'Alice',
  text: 'hello',
  isGroup: false,
  hasMedia: false,
  rawMessage: {},
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  ...overrides,
});

describe('FlowHandler', () => {
  beforeEach(() => {
    // Clear all registered flows and sessions
    (FlowHandler as any).flows = {};
    if ((SessionManager as any).sessions) {
      (SessionManager as any).sessions.clear();
    }
  });

  describe('register', () => {
    test('should register a flow processor', () => {
      const processor = mock(async () => {});
      FlowHandler.register('testFlow', processor);
      expect((FlowHandler as any).flows['testFlow']).toBe(processor);
    });

    test('should overwrite an existing flow processor when re-registered', () => {
      const proc1 = mock(async () => {});
      const proc2 = mock(async () => {});
      FlowHandler.register('flow', proc1);
      FlowHandler.register('flow', proc2);
      expect((FlowHandler as any).flows['flow']).toBe(proc2);
    });
  });

  describe('handle', () => {
    test('should return false when user has no active session', async () => {
      const ctx = createMockCtx();
      const result = await FlowHandler.handle(ctx);
      expect(result).toBe(false);
    });

    test('should return false when user session has no activeFlow', async () => {
      const ctx = createMockCtx();
      // Manually put a session with no active flow
      (SessionManager as any).sessions.set('whatsapp:user-456', {
        activeFlow: null,
        flows: {},
      });

      const result = await FlowHandler.handle(ctx);
      expect(result).toBe(false);
    });

    test('should invoke the registered flow processor and return true', async () => {
      const processor = mock(async () => {});
      FlowHandler.register('myFlow', processor);

      SessionManager.set('user-456', 'myFlow', { flow: 'myFlow', step: 'step1', data: {} }, 'whatsapp');

      const ctx = createMockCtx({ text: 'some input' });
      const result = await FlowHandler.handle(ctx);

      expect(result).toBe(true);
      expect(processor).toHaveBeenCalledTimes(1);
    });

    test('should cancel flow on /cancel command and return true', async () => {
      const processor = mock(async () => {});
      FlowHandler.register('myFlow', processor);

      SessionManager.set('user-456', 'myFlow', { flow: 'myFlow', step: 'step1', data: {} }, 'whatsapp');

      const ctx = createMockCtx({ text: '/cancel' });
      const result = await FlowHandler.handle(ctx);

      expect(result).toBe(true);
      expect(processor).not.toHaveBeenCalled();
      expect(ctx.react).toHaveBeenCalledWith('✅');
      expect(ctx.reply).toHaveBeenCalledWith('❌ Active flow cancelled.');

      // Session should be cleared
      expect(SessionManager.get('user-456', 'whatsapp')).toBeNull();
    });

    test('should cancel flow on /batal command and return true', async () => {
      FlowHandler.register('myFlow', mock(async () => {}));
      SessionManager.set('user-456', 'myFlow', { flow: 'myFlow', step: 'step1', data: {} }, 'whatsapp');

      const ctx = createMockCtx({ text: '/batal' });
      const result = await FlowHandler.handle(ctx);

      expect(result).toBe(true);
      expect(ctx.reply).toHaveBeenCalledWith('❌ Active flow cancelled.');
    });

    test('should clear flow and return false when a new slash command is sent (not cancel)', async () => {
      FlowHandler.register('myFlow', mock(async () => {}));
      SessionManager.set('user-456', 'myFlow', { flow: 'myFlow', step: 'step1', data: {} }, 'whatsapp');

      const ctx = createMockCtx({ text: '/help' });
      const result = await FlowHandler.handle(ctx);

      // Returns false so the router can handle /help
      expect(result).toBe(false);
      // Session should be cleared
      expect(SessionManager.get('user-456', 'whatsapp')).toBeNull();
    });

    test('should handle processor errors gracefully and clear the flow', async () => {
      const error = new Error('something went wrong');
      const processor = mock(async () => { throw error; });
      FlowHandler.register('errorFlow', processor);

      SessionManager.set('user-456', 'errorFlow', { flow: 'errorFlow', step: 'step1', data: {} }, 'whatsapp');

      const ctx = createMockCtx({ text: 'trigger' });
      const result = await FlowHandler.handle(ctx);

      expect(result).toBe(true);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('something went wrong')
      );
      // Flow should be cleared after error
      expect(SessionManager.get('user-456', 'whatsapp')).toBeNull();
    });

    test('should return false if no processor is registered for the active flow', async () => {
      // Set session with a flow that has no registered processor
      SessionManager.set('user-456', 'unknownFlow', { flow: 'unknownFlow', step: 'step1', data: {} }, 'whatsapp');

      const ctx = createMockCtx({ text: 'hello' });
      const result = await FlowHandler.handle(ctx);

      expect(result).toBe(false);
    });
  });
});
