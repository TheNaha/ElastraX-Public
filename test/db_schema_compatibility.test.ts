import { expect, test, describe } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { chatRooms } from '../src/db/schema';
import { createDatabase, ensureDatabaseSchema } from '../src/db';
import {
  acquireDatabaseLease,
  claimInboxEvents,
  claimOutboxMessages,
  enqueueInboxEvent,
  enqueueOutboxMessage,
  enqueueScheduledDelivery,
  markDeliverySent,
  markInboxCompleted,
  recordIdentityAliases,
} from '../src/db/runtime';
import { applyRetentionPolicy } from '../src/db/retention';
import { verifyStoredSchemaFingerprint } from '../src/db/migrations';

// Mock migrations (or manually create schema)
describe('Schema Compatibility', () => {
  test('should support ON CONFLICT DO NOTHING', async () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);

    // Manually create schema matching chatRooms
    sqlite.run(`
      CREATE TABLE chat_rooms (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        language TEXT DEFAULT 'en' NOT NULL,
        system_prompt TEXT,
        context_limit INTEGER,
        temperature REAL,
        max_tokens INTEGER,
        allow_tools INTEGER,
        auto_reply_all INTEGER,
        summarize INTEGER,
        long_term_memory INTEGER,
        created_at INTEGER NOT NULL
      )
    `);

    const chatId = 'test-room-123';

    // First insert (should succeed)
    await db.insert(chatRooms).values({
      id: chatId,
      platform: 'whatsapp',
      language: 'en',
      created_at: new Date(),
    }).onConflictDoNothing();

    const check1 = await db.select().from(chatRooms);
    expect(check1.length).toBe(1);

    // Second insert (duplicate PK, should do nothing)
    await db.insert(chatRooms).values({
      id: chatId,
      platform: 'discord', // Changing platform to verify it wasn't updated
      language: 'id',
      created_at: new Date(),
    }).onConflictDoNothing();

    const check2 = await db.select().from(chatRooms);
    expect(check2.length).toBe(1);
    expect(check2[0].platform).toBe('whatsapp'); // Should remain whatsapp
    sqlite.close();
  });

  test('enforces platform-scoped identities and provider message IDs', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      await ensureDatabaseSchema({ database: handle, leaseName: null });
      handle.sqlite.exec(`
        INSERT INTO chat_rooms (id, platform, created_at) VALUES ('wa-room', 'whatsapp', 1000);
        INSERT INTO chat_rooms (id, platform, created_at) VALUES ('discord-room', 'discord', 1000);
        INSERT INTO messages (chat_room_id, provider_message_id, sender_id, sender_name, role, content, created_at)
          VALUES ('wa-room', 'shared-provider-id', 'wa-user', 'WA', 'user', 'wa', 1000);
        INSERT INTO messages (chat_room_id, provider_message_id, sender_id, sender_name, role, content, created_at)
          VALUES ('discord-room', 'shared-provider-id', 'discord-user', 'Discord', 'user', 'discord', 1000);
        INSERT INTO messages (chat_room_id, provider_message_id, sender_id, sender_name, role, content, created_at)
          VALUES ('wa-room', 'unknown', 'bot', 'Bot', 'assistant', 'first', 1000);
        INSERT INTO messages (chat_room_id, provider_message_id, sender_id, sender_name, role, content, created_at)
          VALUES ('wa-room', 'unknown', 'bot', 'Bot', 'assistant', 'second', 1000);
        INSERT INTO user_roles (user_id, platform, scope, role, granted_by, created_at)
          VALUES ('shared-user', 'whatsapp', 'global', 'user', 'test', 1000);
        INSERT INTO user_roles (user_id, platform, scope, role, granted_by, created_at)
          VALUES ('shared-user', 'discord', 'global', 'user', 'test', 1000);
        INSERT INTO user_identities (lid, platform, updated_at) VALUES ('shared-lid', 'whatsapp', 1000);
        INSERT INTO user_identities (lid, platform, updated_at) VALUES ('shared-lid', 'discord', 1000);
      `);

      const platforms = handle.sqlite
        .query<{ platform: string }, []>('SELECT platform FROM messages ORDER BY platform')
        .all()
        .map(row => row.platform);
      expect(platforms.filter(platform => platform === 'discord')).toHaveLength(1);
      expect(platforms.filter(platform => platform === 'whatsapp')).toHaveLength(3);
      expect(handle.sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM messages WHERE provider_message_id = 'unknown'").get()?.count).toBe(2);
      expect(handle.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM user_roles').get()?.count).toBe(2);
      expect(handle.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM user_identities').get()?.count).toBe(2);
    } finally {
      handle.close();
    }
  });

  test('atomically queues durable work, preserves aliases, and leases one owner', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      await ensureDatabaseSchema({ database: handle, leaseName: null });
      const firstInboxId = enqueueInboxEvent(handle.sqlite, {
        platform: 'whatsapp',
        chatRoomId: 'room',
        providerMessageId: 'unknown',
        eventKey: 'event-1',
        now: 1_000,
      });
      const repeatedInboxId = enqueueInboxEvent(handle.sqlite, {
        platform: 'whatsapp',
        chatRoomId: 'room',
        providerMessageId: 'unknown',
        eventKey: 'event-1',
        now: 1_001,
      });
      enqueueInboxEvent(handle.sqlite, {
        platform: 'whatsapp',
        chatRoomId: 'room',
        providerMessageId: 'unknown',
        eventKey: 'event-2',
        now: 1_002,
      });
      expect(repeatedInboxId).toBe(firstInboxId);
      const claimedInbox = claimInboxEvents(handle.sqlite, 'inbox-worker', { now: 2_000, leaseMs: 10_000 });
      expect(claimedInbox).toHaveLength(2);
      expect(markInboxCompleted(handle.sqlite, firstInboxId, 'inbox-worker', 2_100)).toBe(true);

      const outboxId = enqueueOutboxMessage(handle.sqlite, {
        id: 'outbox-1',
        platform: 'whatsapp',
        chatRoomId: 'room',
        idempotencyKey: 'reply-1',
        payload: '{"text":"hello"}',
        now: 1_000,
      });
      expect(enqueueOutboxMessage(handle.sqlite, {
        id: 'outbox-2',
        platform: 'whatsapp',
        chatRoomId: 'room',
        idempotencyKey: 'reply-1',
        payload: '{"text":"changed"}',
        now: 1_001,
      })).toBe(outboxId);
      expect(handle.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM message_outbox').get()?.count).toBe(1);

      const claimed = claimOutboxMessages(handle.sqlite, 'worker-a', { now: 2_000, leaseMs: 10_000 });
      expect(claimed).toHaveLength(1);
      expect(markDeliverySent(handle.sqlite, 'message_outbox', outboxId, 'worker-a', 'provider-sent', 2_100)).toBe(true);

      enqueueScheduledDelivery(handle.sqlite, {
        id: 'scheduled-1',
        platform: 'whatsapp',
        jobKey: 'digest:2026-01-01',
        chatRoomId: 'room',
        payload: '{}',
        scheduledAt: 5_000,
        now: 1_000,
      });
      expect(handle.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM scheduled_deliveries').get()?.count).toBe(1);

      recordIdentityAliases(handle.sqlite, {
        canonicalId: 'whatsapp:canonical-1',
        platform: 'whatsapp',
        primaryAlias: 'primary@s.whatsapp.net',
        aliases: [
          { value: 'primary@s.whatsapp.net', kind: 'pn' },
          { value: '123@lid', kind: 'lid' },
        ],
        now: 2_000,
      });
      expect(handle.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM identity_aliases').get()?.count).toBe(2);

      const firstLease = acquireDatabaseLease(handle.sqlite, { name: 'worker', owner: 'one', now: 1_000, ttlMs: 1_000 });
      expect(firstLease).not.toBeNull();
      expect(acquireDatabaseLease(handle.sqlite, { name: 'worker', owner: 'two', now: 1_500, ttlMs: 1_000 })).toBeNull();
      expect(acquireDatabaseLease(handle.sqlite, { name: 'worker', owner: 'two', now: 2_100, ttlMs: 1_000 })).not.toBeNull();
    } finally {
      handle.close();
    }
  });

  test('preserves identity aliases across the existing merge-and-delete pattern', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      await ensureDatabaseSchema({ database: handle, leaseName: null });
      handle.sqlite.exec(`
        INSERT INTO user_identities (lid, pn, platform, display_name, updated_at)
          VALUES ('lid:a', 'pn:shared', 'whatsapp', 'Primary', 1000);
        INSERT INTO user_identities (lid, platform, display_name, updated_at)
          VALUES ('lid:b', 'whatsapp', 'Secondary', 1001);
        DELETE FROM user_identities WHERE lid = 'lid:b';
        UPDATE user_identities
        SET lid = 'lid:b', pn = 'pn:shared', updated_at = 1002
        WHERE lid = 'lid:a';
      `);

      const aliases = handle.sqlite
        .query<{ alias: string; canonical_id: string }, []>('SELECT alias, canonical_id FROM identity_aliases ORDER BY alias')
        .all();
      expect(aliases.map(row => row.alias)).toEqual(['lid:a', 'lid:b', 'pn:shared']);
      expect(new Set(aliases.map(row => row.canonical_id)).size).toBe(1);
    } finally {
      handle.close();
    }
  });

  test('detects schema drift after recording the migration fingerprint', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      await ensureDatabaseSchema({ database: handle, leaseName: null });
      expect(verifyStoredSchemaFingerprint(handle.sqlite)).toMatch(/^[a-f0-9]{64}$/);
      handle.sqlite.exec('CREATE TABLE unexpected_schema_drift (id TEXT PRIMARY KEY)');
      expect(() => verifyStoredSchemaFingerprint(handle.sqlite)).toThrow('fingerprint mismatch');
    } finally {
      handle.close();
    }
  });

  test('previews and applies bounded retention without deleting pending work', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      await ensureDatabaseSchema({ database: handle, leaseName: null });
      const now = 200_000_000;
      handle.sqlite.exec(`
        INSERT INTO chat_rooms (id, platform, created_at) VALUES ('room', 'whatsapp', 1);
        INSERT INTO messages (chat_room_id, platform, provider_message_id, sender_id, sender_name, role, content, created_at)
          VALUES ('room', 'whatsapp', 'old', 'sender', 'Sender', 'user', 'old', 1);
        INSERT INTO messages (chat_room_id, platform, provider_message_id, sender_id, sender_name, role, content, created_at)
          VALUES ('room', 'whatsapp', 'new', 'sender', 'Sender', 'user', 'new', ${now / 1000});
        INSERT INTO reminders (chat_room_id, sender_id, sender_name, message, remind_at, is_sent, platform, created_at)
          VALUES ('room', 'sender', 'Sender', 'old', 1, 1, 'whatsapp', 1);
        INSERT INTO reminders (chat_room_id, sender_id, sender_name, message, remind_at, is_sent, platform, created_at)
          VALUES ('room', 'sender', 'Sender', 'pending', ${now / 1000}, 0, 'whatsapp', ${now / 1000});
      `);

      const preview = applyRetentionPolicy(handle.sqlite, {
        messagesDays: 1,
        sentRemindersDays: 1,
        terminalDeliveriesDays: 1,
        expiredFlowSessionsDays: 1,
      }, { now, dryRun: true });
      expect(preview.messages).toBe(1);
      expect(preview.reminders).toBe(1);
      expect(handle.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM messages').get()?.count).toBe(2);

      applyRetentionPolicy(handle.sqlite, {
        messagesDays: 1,
        sentRemindersDays: 1,
        terminalDeliveriesDays: 1,
        expiredFlowSessionsDays: 1,
      }, { now, dryRun: false, batchSize: 1 });
      expect(handle.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM messages').get()?.count).toBe(1);
      expect(handle.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM reminders WHERE is_sent = 0').get()?.count).toBe(1);
    } finally {
      handle.close();
    }
  });
});
