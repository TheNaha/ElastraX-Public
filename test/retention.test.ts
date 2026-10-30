/**
 * @file test/retention.test.ts
 * @description Tests for `applyRetentionPolicy` in `src/db/retention.ts`.
 *
 * Retention is implemented against its spec (openspec/specs/retention/spec.md)
 * but previously had no dedicated tests. These tests use a real, per-worker
 * temporary SQLite database (`createTempDatabase`) and never touch `data/`.
 *
 * All timestamps are epoch milliseconds, matching the schema's timestamp mode.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyRetentionPolicy } from '../src/db/retention';
import { createTempDatabase, type TempDatabase } from './helpers/database';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

let database: TempDatabase;
let sqlite: Database;

beforeEach(() => {
  database = createTempDatabase();
  sqlite = database.sqlite;
  sqlite.exec('PRAGMA foreign_keys = ON;');
  // A chat room so message/reminder FK references resolve.
  sqlite.exec("INSERT INTO chat_rooms (id, platform, created_at) VALUES ('room-1', 'whatsapp', 1000)");
});

afterEach(() => {
  database.cleanup();
});

function countMessages(): number {
  const row = sqlite
    .query<{ n: number }, []>('SELECT count(*) AS n FROM messages')
    .get() as { n: number };
  return Number(row.n);
}

function countReminders(): number {
  const row = sqlite
    .query<{ n: number }, []>('SELECT count(*) AS n FROM reminders')
    .get() as { n: number };
  return Number(row.n);
}

function countInbox(): number {
  const row = sqlite
    .query<{ n: number }, []>('SELECT count(*) AS n FROM message_inbox')
    .get() as { n: number };
  return Number(row.n);
}

function countOutbox(): number {
  const row = sqlite
    .query<{ n: number }, []>('SELECT count(*) AS n FROM message_outbox')
    .get() as { n: number };
  return Number(row.n);
}

function countFlowSessions(): number {
  const row = sqlite
    .query<{ n: number }, []>('SELECT count(*) AS n FROM flow_sessions')
    .get() as { n: number };
  return Number(row.n);
}

function oldTimestamp(daysAgo: number): number {
  return NOW - daysAgo * DAY_MS;
}

describe('applyRetentionPolicy', () => {
  test('defaults to dry run: reports counts without deleting anything', () => {
    sqlite.exec(
      `INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, raw_message, media_path, mime_type, created_at)
       VALUES ('room-1', 's', 'S', 'user', 'old', '{"x":1}', './x.jpg', 'image/jpeg', ${oldTimestamp(220)})`,
    );
    sqlite.exec(
      `INSERT INTO reminders (chat_room_id, sender_id, sender_name, message, remind_at, is_sent, platform, created_at)
       VALUES ('room-1', 's', 'S', 'ping', ${oldTimestamp(100)}, 1, 'whatsapp', ${oldTimestamp(100)})`,
    );
    sqlite.exec(
      `INSERT INTO message_inbox (platform, chat_room_id, event_key, state, received_at, available_at, created_at, updated_at)
       VALUES ('whatsapp', 'room-1', 'evt-1', 'completed', ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)})`,
    );
    sqlite.exec(
      `INSERT INTO message_outbox (id, platform, chat_room_id, idempotency_key, payload, state, available_at, created_at, updated_at, lease_owner, lease_expires_at)
       VALUES ('out-1', 'whatsapp', 'room-1', 'idem-1', '{}', 'sent', ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)}, 'owner-1', ${NOW + DAY_MS})`,
    );
    sqlite.exec(
      `INSERT INTO flow_sessions (id, data, room_key, updated_at)
       VALUES ('fs-1', '{}', 'room:whatsapp:room-1', ${oldTimestamp(40)})`,
    );

    const result = applyRetentionPolicy(sqlite, {}, { now: NOW });

    expect(result.dryRun).toBe(true);
    expect(result.messages).toBeGreaterThan(0);
    expect(result.reminders).toBeGreaterThan(0);
    expect(result.inbox).toBeGreaterThan(0);
    expect(result.outbox).toBeGreaterThan(0);
    expect(result.flowSessions).toBeGreaterThan(0);
    // Nothing actually removed.
    expect(countMessages()).toBe(1);
    expect(countReminders()).toBe(1);
    expect(countInbox()).toBe(1);
    expect(countOutbox()).toBe(1);
    expect(countFlowSessions()).toBe(1);
  });

  test('apply mode deletes matching rows and returns counts', () => {
    sqlite.exec(
      `INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, created_at)
       VALUES ('room-1', 's', 'S', 'user', 'old', ${oldTimestamp(220)})`,
    );
    sqlite.exec(
      `INSERT INTO reminders (chat_room_id, sender_id, sender_name, message, remind_at, is_sent, platform, created_at)
       VALUES ('room-1', 's', 'S', 'ping', ${oldTimestamp(100)}, 1, 'whatsapp', ${oldTimestamp(100)})`,
    );

    const result = applyRetentionPolicy(sqlite, {}, { now: NOW, dryRun: false });

    expect(result.dryRun).toBe(false);
    expect(result.messages).toBe(1);
    expect(result.reminders).toBe(1);
    expect(countMessages()).toBe(0);
    expect(countReminders()).toBe(0);
  });

  test('batches deletions no larger than batchSize (default 500)', () => {
    for (let i = 0; i < 1_500; i++) {
      sqlite.exec(
        `INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, created_at)
         VALUES ('room-1', 's', 'S', 'user', 'm${i}', ${oldTimestamp(220)})`,
      );
    }

    const result = applyRetentionPolicy(sqlite, {}, { now: NOW, dryRun: false });

    expect(result.messages).toBe(1_500);
    expect(countMessages()).toBe(0);
  });

  test('clamps batchSize to [1, 10_000]', () => {
    sqlite.exec(
      `INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, created_at)
       VALUES ('room-1', 's', 'S', 'user', 'm', ${oldTimestamp(220)})`,
    );

    const tiny = applyRetentionPolicy(sqlite, {}, { now: NOW, dryRun: false, batchSize: 0 });
    expect(tiny.messages).toBe(1);
    expect(countMessages()).toBe(0);

    sqlite.exec(
      `INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, created_at)
       VALUES ('room-1', 's', 'S', 'user', 'm2', ${oldTimestamp(220)})`,
    );
    const huge = applyRetentionPolicy(sqlite, {}, { now: NOW, dryRun: false, batchSize: 99_999 });
    expect(huge.messages).toBe(1);
    expect(countMessages()).toBe(0);
  });

  test('clears raw message payloads for messages older than 7 days', () => {
    sqlite.exec(
      `INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, raw_message, media_path, mime_type, created_at)
       VALUES ('room-1', 's', 'S', 'user', 'old', '{"x":1}', './x.jpg', 'image/jpeg', ${oldTimestamp(10)})`,
    );
    sqlite.exec(
      `INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, raw_message, media_path, mime_type, created_at)
       VALUES ('room-1', 's', 'S', 'user', 'young', '{"y":2}', './y.jpg', 'image/png', ${oldTimestamp(1)})`,
    );

    const result = applyRetentionPolicy(sqlite, {}, { now: NOW, dryRun: false });

    expect(result.rawMessages).toBe(1);
    const oldRow = sqlite
      .query<{ raw: string | null; media: string | null; mime: string | null }, [string]>(
        'SELECT raw_message AS raw, media_path AS media, mime_type AS mime FROM messages WHERE content = ?',
      )
      .get('old') as { raw: string | null; media: string | null; mime: string | null };
    expect(oldRow.raw).toBeNull();
    expect(oldRow.media).toBeNull();
    expect(oldRow.mime).toBeNull();

    const youngRow = sqlite
      .query<{ raw: string | null }, [string]>(
        'SELECT raw_message AS raw FROM messages WHERE content = ?',
      )
      .get('young') as { raw: string | null };
    expect(youngRow.raw).toBe('{"y":2}');
  });

  test('retains messages younger than messagesDays + messageDeleteGraceDays (default 180 + 30)', () => {
    // 220 days ago: older than 210-day threshold -> deleted
    sqlite.exec(
      `INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, created_at)
       VALUES ('room-1', 's', 'S', 'user', 'old', ${oldTimestamp(220)})`,
    );
    // 209 days ago: within 210-day threshold -> retained
    sqlite.exec(
      `INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, created_at)
       VALUES ('room-1', 's', 'S', 'user', 'young', ${oldTimestamp(209)})`,
    );

    applyRetentionPolicy(sqlite, {}, { now: NOW, dryRun: false });

    expect(countMessages()).toBe(1);
    const remaining = sqlite
      .query<{ content: string }, []>('SELECT content FROM messages')
      .all() as Array<{ content: string }>;
    expect(remaining.map(r => r.content)).toEqual(['young']);
  });

  test('deletes non-recurring sent reminders older than sentRemindersDays (default 90)', () => {
    sqlite.exec(
      `INSERT INTO reminders (chat_room_id, sender_id, sender_name, message, remind_at, is_sent, platform, created_at)
       VALUES ('room-1', 's', 'S', 'old-sent', ${oldTimestamp(100)}, 1, 'whatsapp', ${oldTimestamp(100)})`,
    );

    const result = applyRetentionPolicy(sqlite, {}, { now: NOW, dryRun: false });

    expect(result.reminders).toBe(1);
    expect(countReminders()).toBe(0);
  });

  test('retains recurring reminders and unsent reminders regardless of age', () => {
    sqlite.exec(
      `INSERT INTO reminders (chat_room_id, sender_id, sender_name, message, remind_at, is_sent, platform, recurrence, created_at)
       VALUES ('room-1', 's', 'S', 'recurring', ${oldTimestamp(200)}, 1, 'whatsapp', 'daily', ${oldTimestamp(200)})`,
    );
    sqlite.exec(
      `INSERT INTO reminders (chat_room_id, sender_id, sender_name, message, remind_at, is_sent, platform, created_at)
       VALUES ('room-1', 's', 'S', 'unsent-old', ${oldTimestamp(200)}, 0, 'whatsapp', ${oldTimestamp(200)})`,
    );

    const result = applyRetentionPolicy(sqlite, {}, { now: NOW, dryRun: false });

    expect(result.reminders).toBe(0);
    expect(countReminders()).toBe(2);
  });

  test('deletes terminal inbox and outbox rows older than terminalDeliveriesDays (default 90)', () => {
    sqlite.exec(
      `INSERT INTO message_inbox (platform, chat_room_id, event_key, state, received_at, available_at, created_at, updated_at)
       VALUES ('whatsapp', 'room-1', 'evt-completed', 'completed', ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)})`,
    );
    sqlite.exec(
      `INSERT INTO message_inbox (platform, chat_room_id, event_key, state, received_at, available_at, created_at, updated_at)
       VALUES ('whatsapp', 'room-1', 'evt-dead', 'dead_letter', ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)})`,
    );
    sqlite.exec(
      `INSERT INTO message_outbox (id, platform, chat_room_id, idempotency_key, payload, state, available_at, created_at, updated_at, lease_owner, lease_expires_at)
       VALUES ('out-sent', 'whatsapp', 'room-1', 'idem-sent', '{}', 'sent', ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)}, 'owner-1', ${NOW + DAY_MS})`,
    );
    sqlite.exec(
      `INSERT INTO message_outbox (id, platform, chat_room_id, idempotency_key, payload, state, available_at, created_at, updated_at, lease_owner, lease_expires_at)
       VALUES ('out-dead', 'whatsapp', 'room-1', 'idem-dead', '{}', 'dead_letter', ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)}, 'owner-1', ${NOW + DAY_MS})`,
    );

    const result = applyRetentionPolicy(sqlite, {}, { now: NOW, dryRun: false });

    expect(result.inbox).toBe(2);
    expect(result.outbox).toBe(2);
    expect(countInbox()).toBe(0);
    expect(countOutbox()).toBe(0);
  });

  test('garbage-collects stale non-terminal deliveries past the terminal window', () => {
    sqlite.exec(
      `INSERT INTO message_inbox (platform, chat_room_id, event_key, state, received_at, available_at, created_at, updated_at)
       VALUES ('whatsapp', 'room-1', 'evt-pending', 'received', ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)})`,
    );
    sqlite.exec(
      `INSERT INTO message_inbox (platform, chat_room_id, event_key, state, received_at, available_at, created_at, updated_at)
       VALUES ('whatsapp', 'room-1', 'evt-failed', 'failed', ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)})`,
    );
    sqlite.exec(
      `INSERT INTO message_outbox (id, platform, chat_room_id, idempotency_key, payload, state, available_at, created_at, updated_at, lease_owner, lease_expires_at)
       VALUES ('out-pending', 'whatsapp', 'room-1', 'idem-pending', '{}', 'pending', ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)}, 'owner-1', ${NOW + DAY_MS})`,
    );
    sqlite.exec(
      `INSERT INTO message_outbox (id, platform, chat_room_id, idempotency_key, payload, state, available_at, created_at, updated_at, lease_owner, lease_expires_at)
       VALUES ('out-leased', 'whatsapp', 'room-1', 'idem-leased', '{}', 'leased', ${oldTimestamp(100)}, ${oldTimestamp(100)}, ${oldTimestamp(100)}, 'owner-1', ${NOW + DAY_MS})`,
    );

    const result = applyRetentionPolicy(sqlite, {}, { now: NOW, dryRun: false });

    expect(result.inboxStale).toBe(2);
    expect(result.outboxStale).toBe(2);
    expect(countInbox()).toBe(0);
    expect(countOutbox()).toBe(0);
  });

  test('deletes expired flow sessions older than expiredFlowSessionsDays (default 30)', () => {
    sqlite.exec(
      `INSERT INTO flow_sessions (id, data, room_key, updated_at)
       VALUES ('fs-old', '{}', 'room:whatsapp:room-1', ${oldTimestamp(40)})`,
    );
    sqlite.exec(
      `INSERT INTO flow_sessions (id, data, room_key, updated_at)
       VALUES ('fs-young', '{}', 'room:whatsapp:room-1', ${oldTimestamp(10)})`,
    );

    const result = applyRetentionPolicy(sqlite, {}, { now: NOW, dryRun: false });

    expect(result.flowSessions).toBe(1);
    expect(countFlowSessions()).toBe(1);
    const remaining = sqlite
      .query<{ id: string }, []>('SELECT id FROM flow_sessions')
      .all() as Array<{ id: string }>;
    expect(remaining.map(r => r.id)).toEqual(['fs-young']);
  });

  test('honors custom policy overrides', () => {
    // messagesDays=1, grace=0 -> anything older than 1 day is deleted.
    sqlite.exec(
      `INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, created_at)
       VALUES ('room-1', 's', 'S', 'user', 'old', ${oldTimestamp(2)})`,
    );
    sqlite.exec(
      `INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, created_at)
       VALUES ('room-1', 's', 'S', 'user', 'young', ${oldTimestamp(0)})`,
    );

    const result = applyRetentionPolicy(
      sqlite,
      { messagesDays: 1, messageDeleteGraceDays: 0 },
      { now: NOW, dryRun: false },
    );

    expect(result.messages).toBe(1);
    expect(countMessages()).toBe(1);
    const remaining = sqlite
      .query<{ content: string }, []>('SELECT content FROM messages')
      .all() as Array<{ content: string }>;
    expect(remaining.map(r => r.content)).toEqual(['young']);
  });

  test('returns zero counts when nothing matches', () => {
    const result = applyRetentionPolicy(sqlite, {}, { now: NOW, dryRun: false });

    expect(result.messages).toBe(0);
    expect(result.reminders).toBe(0);
    expect(result.inbox).toBe(0);
    expect(result.outbox).toBe(0);
    expect(result.flowSessions).toBe(0);
    expect(result.rawMessages).toBe(0);
    expect(result.dryRun).toBe(false);
  });
});
