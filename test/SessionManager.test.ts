import { expect, test, describe, beforeEach, afterEach, setSystemTime, mock } from 'bun:test';
import { SessionManager, FlowSession } from '../src/utils/SessionManager';

// Mock logger to suppress output
const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  error: () => {},
  warn: () => {},
  child: () => _mockLogger,
};
mock.module("../src/utils/logger", () => ({ logger: _mockLogger }));

describe('SessionManager', () => {
  const testManager = SessionManager as unknown as {
    sessions: Map<string, unknown>;
    persistQueue: Map<string, Promise<void>>;
    dbDepsPromise: unknown;
    dbLoaded: boolean;
    dbLoadPromise: Promise<void> | null;
    getDbDeps: () => Promise<unknown>;
  };
  const originalGetDbDeps = testManager.getDbDeps;

  async function flushPersistenceQueue(): Promise<void> {
    const pending = Array.from(testManager.persistQueue.values());
    if (pending.length > 0) {
      await Promise.all(pending);
    }
  }

  // Clear sessions before each test to ensure isolation
  beforeEach(() => {
    testManager.getDbDeps = async () => ({
      db: {
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: () => ({
              run: async () => {},
            }),
          }),
        }),
        delete: () => ({
          where: () => ({
            run: async () => {},
          }),
        }),
      },
      flowSessions: { id: 'id' },
    });

    // Access private static sessions map
    if (testManager.sessions) {
      testManager.sessions.clear();
    }
    if (testManager.persistQueue) {
      testManager.persistQueue.clear();
    }
    if (testManager.dbDepsPromise !== undefined) {
      testManager.dbDepsPromise = null;
    }
    testManager.dbLoaded = false;
    testManager.dbLoadPromise = null;
    setSystemTime(new Date('2024-01-01T00:00:00Z')); // predictable time
  });

  afterEach(async () => {
    await flushPersistenceQueue();
    testManager.getDbDeps = originalGetDbDeps;
    testManager.dbDepsPromise = null;
    testManager.dbLoaded = false;
    testManager.dbLoadPromise = null;
    testManager.persistQueue.clear();
    testManager.sessions.clear();
    setSystemTime(); // restore system time
  });

  const userId = 'user123';
  const flowId = 'onboarding';
  const flowData: Omit<FlowSession, 'expiresAt'> = {
    flow: 'onboarding',
    step: 'start',
    data: { name: 'John' }
  };
  const platform = 'whatsapp';

  describe('set', () => {
    test('should create a new session if one does not exist', () => {
      SessionManager.set(userId, flowId, flowData, platform);

      const session = SessionManager.get(userId, platform);
      expect(session).not.toBeNull();
      if (!session) throw new Error('Session should not be null');

      expect(session.activeFlow).toBe(flowId);
      expect(session.flows[flowId]).toBeDefined();
      expect(session.flows[flowId].data).toEqual(flowData.data);
    });

    test('should update an existing session with a new flow', () => {
      SessionManager.set(userId, flowId, flowData, platform);

      const newFlowId = 'checkout';
      const newFlowData = { ...flowData, flow: 'checkout' };
      SessionManager.set(userId, newFlowId, newFlowData, platform);

      const session = SessionManager.get(userId, platform);
      if (!session) throw new Error('Session should not be null');

      expect(session.flows[flowId]).toBeDefined();
      expect(session.flows[newFlowId]).toBeDefined();
      expect(session.activeFlow).toBe(newFlowId);
    });

    test('should update the active flow when a flow is updated', () => {
      SessionManager.set(userId, flowId, flowData, platform);
      expect(SessionManager.get(userId, platform)?.activeFlow).toBe(flowId);

      const newFlowId = 'help';
      SessionManager.set(userId, newFlowId, { ...flowData, flow: 'help' }, platform);
      expect(SessionManager.get(userId, platform)?.activeFlow).toBe(newFlowId);
    });

    test('should set the correct expiration time', () => {
      const ttlSeconds = 60;
      SessionManager.set(userId, flowId, flowData, platform, ttlSeconds);

      const session = SessionManager.get(userId, platform);
      if (!session) throw new Error('Session should not be null');

      const flow = session.flows[flowId];
      expect(flow.expiresAt).toBe(new Date('2024-01-01T00:00:00Z').getTime() + ttlSeconds * 1000);
    });

    test('should serialize persistence writes for the same user key', async () => {
      const manager = testManager;
      const originalGetDbDeps = manager.getDbDeps;
      const persistedStates: string[] = [];
      let releaseFirstWrite!: () => void;
      const firstWriteGate = new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      });
      let writeCount = 0;

      manager.dbDepsPromise = null;
      manager.getDbDeps = async () => ({
        db: {
          insert: () => ({
            values: (vals: { data: string }) => ({
              onConflictDoUpdate: () => ({
                run: async () => {
                  writeCount += 1;
                  if (writeCount === 1) {
                    await firstWriteGate;
                  }
                  persistedStates.push(vals.data);
                },
              }),
            }),
          }),
          delete: () => ({
            where: () => ({ run: async () => {} }),
          }),
        },
        flowSessions: { id: 'id' },
      });

      try {
        SessionManager.set(userId, flowId, { ...flowData, step: 'first' }, platform);
        SessionManager.set(userId, flowId, { ...flowData, step: 'second' }, platform);

        await Promise.resolve();
        expect(persistedStates).toEqual([]);

        releaseFirstWrite();
        await Promise.all(Array.from(manager.persistQueue.values()));

        expect(persistedStates).toHaveLength(2);
        expect(JSON.parse(persistedStates[0]).flows[flowId].step).toBe('first');
        expect(JSON.parse(persistedStates[1]).flows[flowId].step).toBe('second');
      } finally {
        manager.getDbDeps = originalGetDbDeps;
        manager.dbDepsPromise = null;
        manager.persistQueue.clear();
      }
    });
  });

  describe('get', () => {
    test('should return null for non-existent session', () => {
      const session = SessionManager.get('nonexistent', platform);
      expect(session).toBeNull();
    });

    test('should return session if exists and valid', () => {
      SessionManager.set(userId, flowId, flowData, platform);
      const session = SessionManager.get(userId, platform);
      expect(session).not.toBeNull();
    });

    test('should remove expired flows', () => {
      const ttlSeconds = 60;
      SessionManager.set(userId, flowId, flowData, platform, ttlSeconds);

      // Advance time beyond expiration
      setSystemTime(new Date('2024-01-01T00:01:01Z'));

      const session = SessionManager.get(userId, platform);
      // Since it was the only flow, the session should be removed
      expect(session).toBeNull();
    });

    test('should keep valid flows while removing expired ones', () => {
      const ttl1 = 60;
      const ttl2 = 120;
      const flowId1 = 'flow1';
      const flowId2 = 'flow2';

      // Set flow1 (expires in 60s)
      SessionManager.set(userId, flowId1, { ...flowData, flow: flowId1 }, platform, ttl1);
      // Set flow2 (expires in 120s)
      SessionManager.set(userId, flowId2, { ...flowData, flow: flowId2 }, platform, ttl2);

      // Advance time to 61s (flow1 expired, flow2 valid)
      setSystemTime(new Date('2024-01-01T00:01:01Z'));

      const session = SessionManager.get(userId, platform);
      expect(session).not.toBeNull();
      if (!session) throw new Error('Session should not be null');

      expect(session.flows[flowId1]).toBeUndefined();
      expect(session.flows[flowId2]).toBeDefined();

      // activeFlow should be updated if it was the expired one?
      // In this case, activeFlow was flow2 (set last), which is still valid.
      expect(session.activeFlow).toBe(flowId2);
    });

    test('should promote a remaining flow when the active flow expires', () => {
       const ttl = 60;

       // Set a long lived flow
       const longFlowId = 'longFlow';
       SessionManager.set(userId, longFlowId, { ...flowData, flow: longFlowId }, platform, 300);

       // Set a short lived flow (active)
       SessionManager.set(userId, flowId, flowData, platform, ttl);

       // Expire the active flow
       setSystemTime(new Date('2024-01-01T00:01:01Z'));

       const session = SessionManager.get(userId, platform);
       expect(session).not.toBeNull();
       if (!session) throw new Error('Session should not be null');

       expect(session.flows[flowId]).toBeUndefined();
       expect(session.flows[longFlowId]).toBeDefined();
       expect(session.activeFlow).toBe(longFlowId);
    });
  });

  describe('getActiveFlow', () => {
    test('should repair a stale activeFlow pointer by falling back to a remaining flow', () => {
      const fallbackFlowId = 'fallback';

      SessionManager.set(userId, fallbackFlowId, { ...flowData, flow: fallbackFlowId }, platform);
      const session = SessionManager.get(userId, platform);
      if (!session) throw new Error('Session should not be null');

      session.activeFlow = 'missing';

      const activeFlow = SessionManager.getActiveFlow(userId, platform);
      expect(activeFlow).not.toBeNull();
      expect(activeFlow).toEqual({
        flowId: fallbackFlowId,
        flow: session.flows[fallbackFlowId],
      });
      expect(session.activeFlow).toBe(fallbackFlowId);
    });
  });

  describe('clear', () => {
    test('should remove a specific flow', () => {
      SessionManager.set(userId, flowId, flowData, platform);
      SessionManager.clear(userId, flowId, platform);

      const session = SessionManager.get(userId, platform);
      expect(session).toBeNull();
    });

    test('should update activeFlow when current active flow is cleared', () => {
      const flow1 = 'flow1';
      const flow2 = 'flow2';

      SessionManager.set(userId, flow1, { ...flowData, flow: flow1 }, platform);
      SessionManager.set(userId, flow2, { ...flowData, flow: flow2 }, platform); // Active is flow2

      SessionManager.clear(userId, flow2, platform);

      const session = SessionManager.get(userId, platform);
      if (!session) throw new Error('Session should not be null');

      expect(session.flows[flow2]).toBeUndefined();
      expect(session.flows[flow1]).toBeDefined();

      // It should pick the last remaining flow as active
      expect(session.activeFlow).toBe(flow1);
    });

    test('should remove session if last flow is cleared', () => {
      SessionManager.set(userId, flowId, flowData, platform);
      SessionManager.clear(userId, flowId, platform);
      const session = SessionManager.get(userId, platform);
      expect(session).toBeNull();
    });

    test('should handle clearing non-existent flows gracefully', () => {
      SessionManager.set(userId, flowId, flowData, platform);
      SessionManager.clear(userId, 'nonexistent', platform);

      const session = SessionManager.get(userId, platform);
      expect(session).not.toBeNull();
      if (!session) throw new Error('Session should not be null');
      expect(session.flows[flowId]).toBeDefined();
    });
  });
});
