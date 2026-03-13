import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { flowSessions } from '../src/db/schema';
import { SessionManager, type FlowSession } from '../src/utils/SessionManager';

describe('SessionManager integration', () => {
  const userId = 'integration-user';
  const flowId = 'wizard';
  const platform = 'whatsapp';
  const flowData: Omit<FlowSession, 'expiresAt'> = {
    flow: 'wizard',
    step: 'collect-email',
    data: { email: 'user@example.com', attempts: 1 },
  };

  const manager = SessionManager as unknown as {
    sessions: Map<string, unknown>;
    dbLoaded: boolean;
    dbLoadPromise: Promise<void> | null;
    persistQueue: Map<string, Promise<void>>;
    getDbDeps: () => Promise<{ db: ReturnType<typeof drizzle>; flowSessions: typeof flowSessions }>;
  };

  const originalGetDbDeps = manager.getDbDeps;
  let sqlite: Database;
  let db: ReturnType<typeof drizzle>;

  async function flushPersistenceQueue(): Promise<void> {
    const pending = Array.from(manager.persistQueue.values());
    if (pending.length > 0) {
      await Promise.all(pending);
    }
  }

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS flow_sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flow_sessions_updated_idx ON flow_sessions (updated_at);
    `);
    manager.getDbDeps = async () => ({ db, flowSessions });
    await db.delete(flowSessions);
    manager.sessions.clear();
    manager.persistQueue.clear();
    manager.dbLoaded = false;
    manager.dbLoadPromise = null;
    setSystemTime(new Date('2024-01-01T00:00:00Z'));
  });

  afterEach(async () => {
    await flushPersistenceQueue();
    await db.delete(flowSessions);
    manager.sessions.clear();
    manager.persistQueue.clear();
    manager.dbLoaded = false;
    manager.dbLoadPromise = null;
    manager.getDbDeps = originalGetDbDeps;
    sqlite.close();
    setSystemTime();
  });

  test('restores persisted sessions from the real database', async () => {
    SessionManager.set(userId, flowId, flowData, platform, 300);
    await flushPersistenceQueue();

    manager.sessions.clear();
    manager.dbLoaded = false;
    manager.dbLoadPromise = null;

    await SessionManager.initialize();

    const restored = SessionManager.get(userId, platform);
    expect(restored).not.toBeNull();
    expect(restored?.activeFlow).toBe(flowId);
    expect(restored?.flows[flowId]?.step).toBe('collect-email');
    expect(restored?.flows[flowId]?.data).toEqual(flowData.data);
  });

  test('prunes expired sessions from the real database during initialization', async () => {
    SessionManager.set(userId, flowId, flowData, platform, 1);
    await flushPersistenceQueue();

    setSystemTime(new Date('2024-01-01T00:00:02Z'));
    manager.sessions.clear();
    manager.dbLoaded = false;
    manager.dbLoadPromise = null;

    await SessionManager.initialize();

    expect(SessionManager.get(userId, platform)).toBeNull();
    const rows = db.select().from(flowSessions).all();
    expect(rows).toHaveLength(0);
  });
});