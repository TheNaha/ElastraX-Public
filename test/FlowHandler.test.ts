import { expect, test, describe, beforeEach, afterEach, mock } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';
import { CANCEL_COMMANDS } from '../src/core/constants';
import { logger } from '../src/utils/logger';
import { db } from '../src/db';
import { eq, ne } from 'drizzle-orm';
import { flowSessions } from '../src/db/schema';
import { FlowHandler, FlowVersionConflictError } from '../src/core/FlowHandler';

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
}) as MessageContext;

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

  describe('session lock recovery', () => {
    test('releases the lock after a version conflict', async () => {
      await expect(FlowHandler.setSession(
        'lock-user',
        'lock-flow',
        { flow: 'lock-flow', step: 'one', data: {} },
        'whatsapp',
        300,
        undefined,
        999,
      )).rejects.toThrow(FlowVersionConflictError);

      await FlowHandler.setSession(
        'lock-user',
        'lock-flow',
        { flow: 'lock-flow', step: 'one', data: {} },
        'whatsapp',
        300,
      );
    });
  });

  describe('handle', () => {
    test('should return false when user has no active session', async () => {
      mockGetActiveFlow.mockReturnValue(null);
      const ctx = createMockCtx();
      const result = await FlowHandler.handle(ctx);
      expect(result).toBe(false);
      expect(mockGetActiveFlow).toHaveBeenCalledWith('user-456', 'whatsapp', 'chat-123');
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

      expect(mockClearSession).toHaveBeenCalledWith('user-456', 'myFlow', 'whatsapp', 'chat-123');
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

    test('releases a session whose step keeps throwing', async () => {
      const processor = mock(async () => { throw new Error('media rejected'); });
      FlowHandler.register('stuckFlow', processor);

      mockGetActiveFlow.mockReturnValue({
        flowId: 'stuckFlow',
        flow: { flow: 'stuckFlow', step: 'collect', data: {} },
      });

      const ctx = createMockCtx({ text: 'next file' });
      // The first two failures keep the session so a transient error can be
      // retried; a step that never recovers must not swallow every later message.
      await FlowHandler.handle(ctx);
      await FlowHandler.handle(ctx);
      expect(mockClearSession).not.toHaveBeenCalled();
      await FlowHandler.handle(ctx);
      expect(mockClearSession).toHaveBeenCalledTimes(1);
    });

    test('should return true if no processor is registered for the active flow', async () => {
      mockGetActiveFlow.mockReturnValue({
        flowId: 'unknownFlow',
        flow: { flow: 'unknownFlow', step: '1', data: {} },
      });

      const ctx = createMockCtx({ text: 'hello' });
      const result = await FlowHandler.handle(ctx);

      expect(result).toBe(true);
      expect(mockClearSession).toHaveBeenCalledWith('user-456', 'unknownFlow', 'whatsapp', 'chat-123');
    });
  });
});

describe('FlowHandler room binding and versioning', () => {
  const originalGetActiveFlow = FlowHandler.getActiveFlow;
  const originalClearSession = FlowHandler.clearSession;
  const originalLoggerWarn = logger.warn;

  beforeEach(async () => {
    FlowHandler.getActiveFlow = originalGetActiveFlow;
    FlowHandler.clearSession = originalClearSession;
    logger.warn = mock(() => {});
    await FlowHandler.hydrate();
    await db.delete(flowSessions).where(ne(flowSessions.id, '__no_such_session__')).run();
  });

  afterEach(async () => {
    logger.warn = originalLoggerWarn;
    await db.delete(flowSessions).where(ne(flowSessions.id, '__no_such_session__')).run();
  });

  test('a flow started in one room is not resumed in another room', async () => {
    await FlowHandler.setSession(
      'user-room-1',
      'myFlow',
      { flow: 'myFlow', step: 'step1', data: {} },
      'whatsapp',
      300,
      'chat-room-1',
    );

    const active = await FlowHandler.getActiveFlow('user-room-1', 'whatsapp', 'chat-room-1');
    expect(active?.flowId).toBe('myFlow');

    const crossRoom = await FlowHandler.getActiveFlow('user-room-1', 'whatsapp', 'chat-room-2');
    expect(crossRoom).toBeNull();
  });

  test('flows on different platforms stay isolated for the same user', async () => {
    await FlowHandler.setSession(
      'user-platform',
      'myFlow',
      { flow: 'myFlow', step: 'step1', data: {} },
      'whatsapp',
      300,
      'chat-room-1',
    );

    expect((await FlowHandler.getActiveFlow('user-platform', 'whatsapp', 'chat-room-1'))?.flowId).toBe('myFlow');
    expect(await FlowHandler.getActiveFlow('user-platform', 'discord', 'chat-room-1')).toBeNull();
  });

  test('a stale expected version is rejected instead of clobbering a newer session', async () => {
    await FlowHandler.setSession(
      'user-version',
      'myFlow',
      { flow: 'myFlow', step: 'step1', data: {} },
      'whatsapp',
      300,
      'chat-room-1',
    );

    const session = await FlowHandler.getSessionAsync('user-version', 'whatsapp', 'chat-room-1');
    const currentVersion = session?.version ?? 0;
    expect(currentVersion).toBeGreaterThan(0);

    await FlowHandler.setSession(
      'user-version',
      'myFlow',
      { flow: 'myFlow', step: 'step2', data: {} },
      'whatsapp',
      300,
      'chat-room-1',
      currentVersion,
    );

    await expect(FlowHandler.clearSession('user-version', 'myFlow', 'whatsapp', 'chat-room-1', currentVersion))
      .rejects.toBeInstanceOf(FlowVersionConflictError);

    const stillActive = await FlowHandler.getActiveFlow('user-version', 'whatsapp', 'chat-room-1');
    expect(stillActive?.flow.step).toBe('step2');
  });

  test('clearSession accepts a numeric version in the room argument position for room-less sessions', async () => {
    await FlowHandler.setSession(
      'user-numeric',
      'myFlow',
      { flow: 'myFlow', step: 'step1', data: {} },
      'whatsapp',
      300,
    );
    const session = await FlowHandler.getSessionAsync('user-numeric', 'whatsapp');
    expect(session?.version).toBeGreaterThan(0);

    await FlowHandler.clearSession('user-numeric', 'myFlow', 'whatsapp', session?.version ?? 0);

    expect(await FlowHandler.getActiveFlow('user-numeric', 'whatsapp')).toBeNull();
  });

  test('clearing a room-less session by version leaves a room-bound session untouched', async () => {
    await FlowHandler.setSession(
      'user-mixed',
      'myFlow',
      { flow: 'myFlow', step: 'step1', data: {} },
      'whatsapp',
      300,
      'chat-room-1',
    );

    await FlowHandler.clearSession('user-mixed', 'myFlow', 'whatsapp', 0);

    expect((await FlowHandler.getActiveFlow('user-mixed', 'whatsapp', 'chat-room-1'))?.flowId).toBe('myFlow');
  });

  test('the deprecated synchronous getSession accessor refuses to run', () => {
    expect(() => (FlowHandler as unknown as { getSession: (u: string) => unknown }).getSession('user-1'))
      .toThrow('deprecated');
  });

  test('pruneAllExpired deletes sessions whose flows all expired, updates mixed sessions', async () => {
    const now = 1_000_000_000_000;
    const expiredFlow = { flow: 'expired', step: 'step1', data: {}, expiresAt: now - 1000 };
    const activeFlow = { flow: 'active', step: 'step1', data: {}, expiresAt: now + 1000 };

    // All flows expired → session should be deleted.
    await db.insert(flowSessions).values({
      id: 'session-all-expired',
      data: JSON.stringify({ activeFlow: 'expired', flows: { expired: expiredFlow }, version: 1 }),
      updated_at: new Date(now),
    }).run();

    // All flows active → session should be untouched.
    await db.insert(flowSessions).values({
      id: 'session-all-active',
      data: JSON.stringify({ activeFlow: 'active', flows: { active: activeFlow }, version: 1 }),
      updated_at: new Date(now),
    }).run();

    // Mixed → expired flow removed, session kept with remaining flow.
    await db.insert(flowSessions).values({
      id: 'session-mixed',
      data: JSON.stringify({ activeFlow: 'active', flows: { expired: expiredFlow, active: activeFlow }, version: 1 }),
      updated_at: new Date(now),
    }).run();

    const pruned = await FlowHandler.pruneAllExpired(now);

    expect(pruned).toBe(1);

    const gone = await db.select().from(flowSessions).where(eq(flowSessions.id, 'session-all-expired'));
    expect(gone).toHaveLength(0);

    const kept = await db.select().from(flowSessions).where(eq(flowSessions.id, 'session-all-active'));
    expect(kept).toHaveLength(1);

    const mixedRows = await db.select().from(flowSessions).where(eq(flowSessions.id, 'session-mixed'));
    expect(mixedRows).toHaveLength(1);
    const mixedData = JSON.parse(mixedRows[0]!.data);
    expect(mixedData.flows.expired).toBeUndefined();
    expect(mixedData.flows.active).toBeDefined();
  });

  test('pruning a base-keyed session via a room lookup updates that row, not a new one', async () => {
    const now = Date.now();
    const expiredFlow = { flow: 'expired', step: 'step1', data: {}, expiresAt: now - 1000 };
    const activeFlow = { flow: 'active', step: 'step1', data: {}, expiresAt: now + 60_000 };
    // Legacy session stored under the room-less base key.
    await db.insert(flowSessions).values({
      id: 'whatsapp:*:user-base-prune',
      data: JSON.stringify({ activeFlow: 'active', flows: { expired: expiredFlow, active: activeFlow }, version: 1 }),
      updated_at: new Date(now),
    }).run();

    const session = await FlowHandler.getSessionAsync('user-base-prune', 'whatsapp', 'chat-prune');

    expect(session?.flows.expired).toBeUndefined();
    expect(session?.flows.active).toBeDefined();
    // The base row is the one that was read and pruned.
    const baseRows = await db.select().from(flowSessions).where(eq(flowSessions.id, 'whatsapp:*:user-base-prune'));
    expect(baseRows).toHaveLength(1);
    expect(JSON.parse(baseRows[0]!.data).flows.expired).toBeUndefined();
    // A room-scoped duplicate must not be created by the fallback path.
    const duplicate = await db.select().from(flowSessions).where(eq(flowSessions.id, 'whatsapp:chat-prune:user-base-prune'));
    expect(duplicate).toHaveLength(0);
  });

  test('handle re-entrantly executes flow processors that call setSession or clearSession without deadlock', async () => {
    let stepExecuted = false;
    FlowHandler.register('reentrant_test_flow', async (ctx, activeFlowData, flowId) => {
      stepExecuted = true;
      await FlowHandler.setSession(ctx.senderId, flowId, {
        flow: 'reentrant_test_flow',
        step: 'step2',
        data: { step1Done: true },
      }, ctx.platform, 300, ctx.chatId);
    });

    await FlowHandler.setSession('user-reentrant', 'test-flow', {
      flow: 'reentrant_test_flow',
      step: 'step1',
      data: {},
    }, 'whatsapp', 300, 'chat-reentrant');

    const ctx = createMockCtx({
      senderId: 'user-reentrant',
      chatId: 'chat-reentrant',
      platform: 'whatsapp',
      text: 'proceed to next step',
    });

    const handled = await FlowHandler.handle(ctx);
    expect(handled).toBe(true);
    expect(stepExecuted).toBe(true);

    const active = await FlowHandler.getActiveFlow('user-reentrant', 'whatsapp', 'chat-reentrant');
    expect(active?.flow.step).toBe('step2');
  });
});
