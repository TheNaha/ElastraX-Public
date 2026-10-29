import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { createTempDatabase, type TempDatabase } from './helpers/database';
import * as schema from '../src/db/schema';
import { eq } from 'drizzle-orm';

const { messageOutbox, messageInbox } = schema;

// Bun module mocks are process-wide, so this file installs a full real database
// behind `../src/db` to stay isolated from (and harmless to) other test files.
const database: TempDatabase = createTempDatabase();
database.sqlite.exec('PRAGMA journal_mode = WAL');

// Mirrors src/db/runtime.ts exactly: the return value must be propagated,
// because callers such as OutboxService.prune rely on it.
function withImmediateTransaction<T>(
  sqlite: TempDatabase['sqlite'],
  operation: () => T,
): T {
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

mock.module('../src/db', () => ({
  db: database.db,
  sqlite: database.sqlite,
  withImmediateTransaction,
  afterMigrationCallbacks: [],
  getDefaultDatabase: () => ({
    sqlite: database.sqlite,
    db: database.db,
    path: database.path,
    close: () => {},
    checkpoint: () => {},
  }),
}));

// Imported dynamically so the `../src/db` mock above is already registered.
const { OutboxService } = await import('../src/messaging/OutboxService');
const { InboxService } = await import('../src/messaging/InboxService');

const db = database.db;

const NOW = Date.now();
const OLD_TS = NOW - 200_000;
const RECENT_TS = NOW;

describe('OutboxService.prune', () => {
  beforeEach(() => {
    db.delete(messageOutbox).run();
  });

  test('removes only terminal rows older than cutoff', async () => {
    await db.insert(messageOutbox).values({
      id: 'old-dead-letter', platform: 'whatsapp', chatRoomId: 'room-1',
      idempotencyKey: 'key-old-dl', payload: JSON.stringify({ text: 'old' }),
      state: 'dead_letter', attemptCount: 0, availableAt: OLD_TS,
      createdAt: OLD_TS, updatedAt: OLD_TS,
    }).run();
    await db.insert(messageOutbox).values({
      id: 'old-failed', platform: 'whatsapp', chatRoomId: 'room-1',
      idempotencyKey: 'key-old-failed', payload: JSON.stringify({ text: 'old' }),
      state: 'failed', attemptCount: 0, availableAt: OLD_TS,
      createdAt: OLD_TS, updatedAt: OLD_TS,
    }).run();
    await db.insert(messageOutbox).values({
      id: 'recent-dead-letter', platform: 'whatsapp', chatRoomId: 'room-1',
      idempotencyKey: 'key-recent-dl', payload: JSON.stringify({ text: 'recent' }),
      state: 'dead_letter', attemptCount: 0, availableAt: RECENT_TS,
      createdAt: RECENT_TS, updatedAt: RECENT_TS,
    }).run();
    await db.insert(messageOutbox).values({
      id: 'old-sent', platform: 'whatsapp', chatRoomId: 'room-1',
      idempotencyKey: 'key-old-sent', payload: JSON.stringify({ text: 'old' }),
      state: 'sent', attemptCount: 0, availableAt: OLD_TS,
      sentAt: OLD_TS, createdAt: OLD_TS, updatedAt: OLD_TS,
    }).run();

    const pruned = OutboxService.prune(100_000);
    expect(pruned).toBe(2);

    const remaining = db.select().from(messageOutbox).all().map(r => r.id);
    expect(remaining).toEqual(expect.arrayContaining(['recent-dead-letter', 'old-sent']));
    expect(remaining).not.toEqual(expect.arrayContaining(['old-dead-letter', 'old-failed']));
  });

  test('does nothing when there are no terminal rows', async () => {
    const pruned = OutboxService.prune(100_000);
    expect(pruned).toBe(0);
  });
});

describe('InboxService.recoverStranded', () => {
  beforeEach(() => {
    db.delete(messageInbox).run();
  });

  test('marks old received rows as failed and releases expired processing leases', async () => {
    await db.insert(messageInbox).values({
      platform: 'whatsapp', chatRoomId: 'room-1', eventKey: 'event-old-received', payload: '{}',
      state: 'received', attemptCount: 0, availableAt: OLD_TS, receivedAt: OLD_TS, createdAt: OLD_TS, updatedAt: OLD_TS,
    }).run();
    await db.insert(messageInbox).values({
      platform: 'whatsapp', chatRoomId: 'room-1', eventKey: 'event-recent-received', payload: '{}',
      state: 'received', attemptCount: 0, availableAt: RECENT_TS, receivedAt: RECENT_TS, createdAt: RECENT_TS, updatedAt: RECENT_TS,
    }).run();
    await db.insert(messageInbox).values({
      platform: 'whatsapp', chatRoomId: 'room-1', eventKey: 'event-expired-processing', payload: '{}',
      state: 'processing', attemptCount: 1, availableAt: RECENT_TS, receivedAt: OLD_TS, createdAt: OLD_TS, updatedAt: OLD_TS,
      leaseOwner: 'worker-1', leaseExpiresAt: OLD_TS, lastError: 'timeout',
    }).run();
    await db.insert(messageInbox).values({
      platform: 'whatsapp', chatRoomId: 'room-1', eventKey: 'event-active-processing', payload: '{}',
      state: 'processing', attemptCount: 1, availableAt: RECENT_TS, receivedAt: RECENT_TS, createdAt: RECENT_TS, updatedAt: RECENT_TS,
      leaseOwner: 'worker-2', leaseExpiresAt: NOW + 100_000,
    }).run();

    const recovered = InboxService.recoverStranded(100_000);
    expect(recovered.received).toBe(1);
    expect(recovered.processing).toBe(1);

    const oldReceived = db.select().from(messageInbox).where(eq(messageInbox.eventKey, 'event-old-received')).all();
    expect(oldReceived[0]!.state).toBe('failed');
    expect(oldReceived[0]!.lastError).toBe('stranded: never claimed');

    const recentReceived = db.select().from(messageInbox).where(eq(messageInbox.eventKey, 'event-recent-received')).all();
    expect(recentReceived[0]!.state).toBe('received');

    const expiredProcessing = db.select().from(messageInbox).where(eq(messageInbox.eventKey, 'event-expired-processing')).all();
    expect(expiredProcessing[0]!.state).toBe('received');
    expect(expiredProcessing[0]!.leaseOwner).toBeNull();

    const activeProcessing = db.select().from(messageInbox).where(eq(messageInbox.eventKey, 'event-active-processing')).all();
    expect(activeProcessing[0]!.state).toBe('processing');
  });

  test('does nothing when there are no stranded rows', async () => {
    const recovered = InboxService.recoverStranded(100_000);
    expect(recovered.received).toBe(0);
    expect(recovered.processing).toBe(0);
  });
});
