import { expect, test, describe, beforeEach, afterEach, mock } from 'bun:test';
import { FlowHandler } from '../src/core/FlowHandler';
import { MessageContext } from '../src/core/MessageContext';
import { CANCEL_COMMANDS } from '../src/core/constants';
import { logger } from '../src/utils/logger';

// We avoid mock.module to prevent polluting other tests in the same run
// Instead we spy on/replace methods on the imported objects/classes

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-123',
  senderId: 'user-456',
  senderName: 'Alice',
  text: 'hello',
  messageId: 'msg-123',
  messageType: 'conversation',
  isGroup: false,
  isBotMentioned: false,
  hasMedia: false,
  mediaReady: Promise.resolve(),
  rawMessage: {},
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  resolveRoles: mock(async () => ['user']),
  language: 'en',
  ...overrides,
});

describe('FlowHandler', () => {
  const flowRegistry = FlowHandler as unknown as { flows: Record<string, unknown> };

  // Save originals
  const originalGetActiveFlow = FlowHandler.getActiveFlow;
  const originalClearSession = FlowHandler.clearSession;
  const originalLoggerDebug = logger.debug;
  const originalLoggerError = logger.error;
  const originalLoggerWarn = logger.warn;

  // Mocks
  let mockGetActiveFlow: ReturnType<typeof mock>;
  let mockClearSession: ReturnType<typeof mock>;

  beforeEach(() => {
    // Reset FlowHandler flows
    flowRegistry.flows = {};

    // Mock FlowHandler methods directly
    mockGetActiveFlow = mock(() => null);
    mockClearSession = mock(() => {});
    FlowHandler.getActiveFlow = mockGetActiveFlow;
    FlowHandler.clearSession = mockClearSession;

    // Mock Logger methods (suppress output)
    logger.debug = mock(() => {});
    logger.error = mock(() => {});
    logger.warn = mock(() => {});
  });

  afterEach(() => {
    // Restore originals
    FlowHandler.getActiveFlow = originalGetActiveFlow;
    FlowHandler.clearSession = originalClearSession;
    logger.debug = originalLoggerDebug;
    logger.error = originalLoggerError;
    logger.warn = originalLoggerWarn;
  });

  describe('register', () => {
    test('should register a flow processor', () => {
      const processor = mock(async () => {});
      FlowHandler.register('testFlow', processor);
      expect(flowRegistry.flows['testFlow']).toBe(processor);
    });
  });

  describe('handle', () => {
    test('should return false when user has no active session', async () => {
      mockGetActiveFlow.mockReturnValue(null);
      const ctx = createMockCtx();
      const result = await FlowHandler.handle(ctx);
      expect(result).toBe(false);
      expect(mockGetActiveFlow).toHaveBeenCalledWith('user-456', 'whatsapp');
    });

    test('should return false when user session has no activeFlow', async () => {
      mockGetActiveFlow.mockReturnValue(null);

      const ctx = createMockCtx();
      const result = await FlowHandler.handle(ctx);
      expect(result).toBe(false);
    });

    test('should return false when session has activeFlow but flow data is missing', async () => {
        mockGetActiveFlow.mockReturnValue(null);

        const ctx = createMockCtx();
        const result = await FlowHandler.handle(ctx);
        expect(result).toBe(false);
    });

    test('should invoke the registered flow processor and return true', async () => {
      const processor = mock(async () => {});
      FlowHandler.register('myFlow', processor);

      const flowData = { flow: 'myFlow', step: 'step1', data: {} };
      mockGetActiveFlow.mockReturnValue({
        flowId: 'myFlow',
        flow: flowData,
      });

      const ctx = createMockCtx({ text: 'some input' });
      const result = await FlowHandler.handle(ctx);

      expect(result).toBe(true);
      expect(processor).toHaveBeenCalledTimes(1);
      expect(processor).toHaveBeenCalledWith(ctx, flowData, 'myFlow');
    });

    test(`should cancel flow on ${CANCEL_COMMANDS[0]} command and return true`, async () => {
      const processor = mock(async () => {});
      FlowHandler.register('myFlow', processor);

      mockGetActiveFlow.mockReturnValue({
        flowId: 'myFlow',
        flow: { flow: 'myFlow', step: '1', data: {} },
      });

      const ctx = createMockCtx({ text: CANCEL_COMMANDS[0] });
      const result = await FlowHandler.handle(ctx);

      expect(result).toBe(true);
      expect(processor).not.toHaveBeenCalled();
      expect(ctx.react).toHaveBeenCalledWith('✅');
      // We check for real translation string
      expect(ctx.reply).toHaveBeenCalledWith('❌ Active flow cancelled.');

      expect(mockClearSession).toHaveBeenCalledWith('user-456', 'myFlow', 'whatsapp');
    });

    test(`should cancel flow on ${CANCEL_COMMANDS[1]} command and return true`, async () => {
      FlowHandler.register('myFlow', mock(async () => {}));
      mockGetActiveFlow.mockReturnValue({
        flowId: 'myFlow',
        flow: { flow: 'myFlow', step: '1', data: {} },
      });

      const ctx = createMockCtx({ text: CANCEL_COMMANDS[1] });
      const result = await FlowHandler.handle(ctx);

      expect(result).toBe(true);
      expect(ctx.reply).toHaveBeenCalledWith('❌ Active flow cancelled.');
    });

    test('should return true with warning when a new slash command is sent (not cancel)', async () => {
      FlowHandler.register('myFlow', mock(async () => {}));
      mockGetActiveFlow.mockReturnValue({
        flowId: 'myFlow',
        flow: { flow: 'myFlow', step: '1', data: {} },
      });

      const ctx = createMockCtx({ text: '/help' });
      const result = await FlowHandler.handle(ctx);

      // Returns true with a warning that user is in an active flow
      expect(result).toBe(true);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('currently in an active process'));
      expect(mockClearSession).not.toHaveBeenCalled();
    });

    test('should handle processor errors gracefully without clearing the flow', async () => {
      const error = new Error('something went wrong');
      const processor = mock(async () => { throw error; });
      FlowHandler.register('errorFlow', processor);

      mockGetActiveFlow.mockReturnValue({
        flowId: 'errorFlow',
        flow: { flow: 'errorFlow', step: '1', data: {} },
      });

      const ctx = createMockCtx({ text: 'trigger' });
      const result = await FlowHandler.handle(ctx);

      expect(result).toBe(true);
      // We check for real translation string with interpolated error
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('❌ An error occurred processing your flow step:\nsomething went wrong')
      );

      // Flow is NOT cleared on error so user can retry
      expect(mockClearSession).not.toHaveBeenCalled();
    });

    test('should return false if no processor is registered for the active flow', async () => {
      mockGetActiveFlow.mockReturnValue({
        flowId: 'unknownFlow',
        flow: { flow: 'unknownFlow', step: '1', data: {} },
      });

      const ctx = createMockCtx({ text: 'hello' });
      const result = await FlowHandler.handle(ctx);

      expect(result).toBe(false);
      expect(mockClearSession).toHaveBeenCalledWith('user-456', 'unknownFlow', 'whatsapp');
    });
  });
});
