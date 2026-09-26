/**
 * @file test/roomKeyDelivery.test.ts
 * @description Cross-platform room identity for the runtime lanes.
 *
 * The suite runs against its own migrated temporary database.  Other suites
 * call `mock.module('../src/db', ...)` with a handle they close afterwards, and
 * that registration lives for the rest of the process, so this file
 * (1) re-registers `../src/db` with the real module bound to a temp handle,
 * (2) imports everything that touches the database dynamically, and
 * (3) restores the real module in `afterAll` so later suites are unaffected.
 *
 * Covers the invariants this migration depends on:
 *  - the same remote room id on two platforms resolves to two canonical rooms;
 *  - inbox/outbox rows are filed under the canonical key while keeping the raw
 *    provider room id for rollback and provider I/O;
 *  - room-scoped reads accept both the canonical key and the legacy raw id;
 *  - providers only ever receive raw remote room ids, on the right platform;
 *  - webhook destinations resolve canonical keys and reject cross-platform
 *    mismatches instead of guessing;
 *  - readiness/liveness responses are untouched by room-key resolution.
 */

import { afterAll, beforeEach, describe, expect, mock, spyOn, test, type Mock } from 'bun:test';
import { withEnvironment } from './helpers/env';
import { createTempDatabase } from './helpers/database';

const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};

const tempDatabase = createTempDatabase();
// A query suffix forces a second instance of the real module (a plain import
// would be resolved against whatever mock another suite registered).
const realDatabaseModulePath: string = '../src/db/index.ts?case=room-key-delivery';
const realDatabaseModule = (await import(realDatabaseModulePath)) as typeof import('../src/db');

mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));
mock.module('../src/db', () => ({
  ...realDatabaseModule,
  db: tempDatabase.db,
  sqlite: tempDatabase.sqlite,
  getDefaultDatabase: () => tempDatabase.sqlite,
}));

import type { MessageContext } from '../src/core/MessageContext';
import type { BotProvider } from '../src/providers/BotProvider';
import type { WebhookDeliveryJob } from '../src/webhooks/types';
import type { AppRuntimeDeps } from '../src/runtime/AppRuntime';

const { sqlite } = await import('../src/db');
const { InboxService } = await import('../src/messaging/InboxService');
const { OutboxService } = await import('../src/messaging/OutboxService');
const {
  canonicalRoomKey,
  hasRoomKeyColumn,
  platformsForRemoteRoomId,
  providerRoomTargetMismatch,
  remoteRoomIdFromKey,
  remoteRoomIdFromRoomKey,
  resolveCanonicalRoomKey,
  resolveRemoteRoomDestination,
} = await import('../src/messaging/roomKeys');
const { AppRuntime } = await import('../src/runtime/AppRuntime');
const { WebhookServer } = await import('../src/webhooks/WebhookServer');
const { ServiceBindingService } = await import('../src/utils/ServiceBindingService');
const { NotificationSubscriptionService } = await import('../src/utils/NotificationSubscriptionService');
const { Scheduler } = await import('../src/utils/Scheduler');
const { fetchRoomTranscript } = await import('../src/utils/DigestService');
const { APP_RELEASE_TAG, APP_VERSION } = await import('../src/config/version');

const WEBHOOK_SECRET = 'room-key-webhook-secret-0123456789';
const JELLYFIN_SECRET = 'room-key-jellyfin-secret-0123456789';

// Every room/message id is namespaced per run: the worker database is shared by
// all test files in a process.
const run = Math.random().toString(36).slice(2, 8);
const SHARED_REMOTE_ID = `555000${run}`;
const WHATSAPP_JID = `628${run}@s.whatsapp.net`;
const PUMP_ROOM = `777000${run}`;
// Registered on WhatsApp only: any Discord delivery must be rejected.
const WHATSAPP_ONLY_ROOM = `888000${run}`;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function insertRoom(roomId: string, platform: string): void {
  sqlite
    .query<never, [string, string, number]>(
      `INSERT OR IGNORE INTO chat_rooms (id, platform, language, created_at)
       VALUES (?, ?, 'en', ?)`,
    )
    .run(roomId, platform, nowSeconds());
}

function insertMessage(options: {
  chatRoomId: string;
  platform: string;
  content: string;
  roomKey?: string | null;
  senderName?: string;
}): number {
  const result = sqlite
    .query<never, [string, string, string | null, string, string, number]>(
      `INSERT INTO messages
         (chat_room_id, platform, room_key, sender_id, sender_name, role, content, created_at)
       VALUES (?, ?, ?, 'tester', ?, 'user', ?, ?)`,
    )
    .run(
      options.chatRoomId,
      options.platform,
      options.roomKey ?? null,
      options.senderName ?? 'Tester',
      options.content,
      nowSeconds(),
    );
  return Number(result.lastInsertRowid);
}

function createContext(platform: 'whatsapp' | 'discord', chatId: string, messageId: string): MessageContext {
  return {
    platform,
    chatId,
    senderId: 'tester',
    senderName: 'Tester',
    text: 'hello',
    isGroup: false,
    isBotMentioned: false,
    messageType: 'conversation',
    hasMedia: false,
    mediaReady: Promise.resolve(),
    messageId,
    rawMessage: {},
    reply: mock(async () => {}),
    checkPermissions: mock(async () => true),
    resolveRoles: mock(async () => ['user']),
  } as unknown as MessageContext;
}

function createProvider(name: BotProvider['name']): BotProvider & { sendMessage: ReturnType<typeof mock> } {
  return {
    name,
    start: mock(async () => {}),
    stop: mock(async () => {}),
    sendMessage: mock(async (_roomId: string, _text: string, _signal?: AbortSignal) => {}),
    onMessage: mock(() => {}),
  } as unknown as BotProvider & { sendMessage: Mock<(roomId: string, text: string, signal?: AbortSignal) => Promise<unknown>> };
}

function insertReminder(chatRoomId: string, roomKey: string, message: string): number {
  const result = sqlite
    .query<never, [string, string, string, number, number]>(
      `INSERT INTO reminders
         (chat_room_id, room_key, sender_id, sender_name, message, remind_at, is_sent, platform, language, created_at)
       VALUES (?, ?, 'tester', 'Tester', ?, ?, 0, 'whatsapp', 'en', ?)`,
    )
    .run(chatRoomId, roomKey, message, nowSeconds() - 60, nowSeconds());
  return Number(result.lastInsertRowid);
}

function portOf(server: InstanceType<typeof WebhookServer>): number {
  const port = (server as unknown as { server?: { port?: number } }).server?.port;
  if (typeof port !== 'number') throw new Error('Webhook server did not start');
  return port;
}

async function withWebhookServer(
  callback: (server: InstanceType<typeof WebhookServer>, baseUrl: string) => Promise<void>,
  register?: (server: InstanceType<typeof WebhookServer>) => void,
): Promise<void> {
  await withEnvironment({
    WEBHOOK_ENABLED: 'true',
    WEBHOOK_HOST: '127.0.0.1',
    WEBHOOK_PORT: '0',
    WEBHOOK_SECRET: WEBHOOK_SECRET,
    WEBHOOK_BODY_SECRET_COMPAT_ENABLED: undefined,
    WEBHOOK_BODY_SECRET_COMPAT_UNTIL: undefined,
    WEBHOOK_QUERY_SECRET_COMPAT_ENABLED: undefined,
    WEBHOOK_QUERY_SECRET_COMPAT_UNTIL: undefined,
    JELLYFIN_WEBHOOK_SECRET: JELLYFIN_SECRET,
    SEERR_WEBHOOK_SECRET: undefined,
  }, async () => {
    const server = new WebhookServer();
    register?.(server);
    server.start();
    try {
      await callback(server, `http://127.0.0.1:${portOf(server)}`);
    } finally {
      server.stop();
    }
  });
}

afterAll(() => {
  for (const id of [SHARED_REMOTE_ID, WHATSAPP_JID, `legacy-${run}`, `dual-${run}`, `discord-legacy-${run}`]) {
    sqlite.query<never, [string]>(`DELETE FROM messages WHERE chat_room_id = ?`).run(id);
    sqlite.query<never, [string]>(`DELETE FROM chat_rooms WHERE id = ?`).run(id);
  }
  for (const id of [SHARED_REMOTE_ID, WHATSAPP_JID, PUMP_ROOM, WHATSAPP_ONLY_ROOM]) {
    sqlite.query<never, [string]>(`DELETE FROM message_inbox WHERE chat_room_id = ?`).run(id);
    sqlite.query<never, [string]>(`DELETE FROM message_outbox WHERE chat_room_id = ?`).run(id);
    sqlite.query<never, [string]>(`DELETE FROM reminders WHERE chat_room_id = ?`).run(id);
  }
  // Hand the real module back so later suites are not left with a temp handle.
  mock.module('../src/db', () => realDatabaseModule);
  tempDatabase.cleanup();
});

describe('canonical room keys', () => {
  test('the same remote id on two platforms yields two distinct canonical keys', () => {
    const whatsappKey = canonicalRoomKey('whatsapp', SHARED_REMOTE_ID);
    const discordKey = canonicalRoomKey('discord', SHARED_REMOTE_ID);

    expect(whatsappKey).not.toBe(discordKey);
    expect(whatsappKey).toContain('whatsapp');
    expect(discordKey).toContain('discord');
    expect(remoteRoomIdFromKey(whatsappKey)).toBe(SHARED_REMOTE_ID);
    expect(remoteRoomIdFromKey(discordKey)).toBe(SHARED_REMOTE_ID);
    expect(remoteRoomIdFromRoomKey('whatsapp', whatsappKey)).toBe(SHARED_REMOTE_ID);
    // A Discord key is never a valid WhatsApp target.
    expect(remoteRoomIdFromRoomKey('whatsapp', discordKey)).toBeNull();
  });

  test('a canonical key that leaks into provider I/O is reported as a mismatch', () => {
    const discordKey = canonicalRoomKey('discord', SHARED_REMOTE_ID);
    expect(providerRoomTargetMismatch('discord', discordKey, SHARED_REMOTE_ID)).toBeNull();
    expect(providerRoomTargetMismatch('whatsapp', discordKey, SHARED_REMOTE_ID)).toContain('whatsapp');
    expect(providerRoomTargetMismatch('discord', discordKey, 'other-room')).toContain('other-room');
    // Legacy rows without a key are accepted as-is.
    expect(providerRoomTargetMismatch('discord', null, SHARED_REMOTE_ID)).toBeNull();
    expect(providerRoomTargetMismatch('discord', SHARED_REMOTE_ID, SHARED_REMOTE_ID)).toBeNull();
  });

  test('inbox admission files each platform under its own key and keeps the raw id', () => {
    expect(hasRoomKeyColumn('message_inbox')).toBe(true);

    const whatsapp = InboxService.admit(createContext('whatsapp', SHARED_REMOTE_ID, `wa-${run}`));
    const discord = InboxService.admit(createContext('discord', SHARED_REMOTE_ID, `dc-${run}`));

    expect(whatsapp.accepted).toBe(true);
    expect(discord.accepted).toBe(true);
    expect(whatsapp.id).not.toBe(discord.id);
    expect(whatsapp.roomKey).toBe(canonicalRoomKey('whatsapp', SHARED_REMOTE_ID));
    expect(discord.roomKey).toBe(canonicalRoomKey('discord', SHARED_REMOTE_ID));
    // The raw provider room id is retained so the row can be rolled back.
    expect(whatsapp.chatRoomId).toBe(SHARED_REMOTE_ID);
    expect(discord.chatRoomId).toBe(SHARED_REMOTE_ID);

    const whatsappRows = InboxService.findByRoom(whatsapp.roomKey, 'whatsapp');
    const discordRows = InboxService.findByRoom(discord.roomKey, 'discord');
    expect(whatsappRows.map(row => row.id)).toEqual([whatsapp.id]);
    expect(discordRows.map(row => row.id)).toEqual([discord.id]);
    expect(whatsappRows[0]?.chatRoomId).toBe(SHARED_REMOTE_ID);
    expect(discordRows[0]?.chatRoomId).toBe(SHARED_REMOTE_ID);

    // Re-admitting the same provider event keeps the pre-existing contract: the
    // row is not inserted twice and the event stays claimable.
    const duplicate = InboxService.admit(createContext('whatsapp', SHARED_REMOTE_ID, `wa-${run}`));
    expect(duplicate.id).toBe(whatsapp.id);
    expect(duplicate.reason).toBe('duplicate');
    expect(duplicate.roomKey).toBe(whatsapp.roomKey);
    // The same message id on the other platform is a different event.
    const otherPlatform = InboxService.admit(createContext('discord', SHARED_REMOTE_ID, `wa-${run}`));
    expect(otherPlatform.accepted).toBe(true);
    expect(otherPlatform.roomKey).toBe(canonicalRoomKey('discord', SHARED_REMOTE_ID));
    expect(otherPlatform.id).not.toBe(whatsapp.id);
  });

  test('outbox rows keep the canonical key, the raw id, and stay platform scoped', () => {
    expect(hasRoomKeyColumn('message_outbox')).toBe(true);

    const whatsappKey = resolveCanonicalRoomKey('whatsapp', SHARED_REMOTE_ID);
    const discordKey = resolveCanonicalRoomKey('discord', SHARED_REMOTE_ID);
    OutboxService.enqueueText('whatsapp', SHARED_REMOTE_ID, 'wa hello', [`outbox-wa-${run}`], { roomKey: whatsappKey });
    OutboxService.enqueueText('discord', SHARED_REMOTE_ID, 'dc hello', [`outbox-dc-${run}`], { roomKey: discordKey });

    const whatsappRows = OutboxService.pendingForRoom(whatsappKey, 'whatsapp');
    const discordRows = OutboxService.pendingForRoom(discordKey, 'discord');
    expect(whatsappRows).toHaveLength(1);
    expect(discordRows).toHaveLength(1);
    expect(whatsappRows[0]?.chatRoomId).toBe(SHARED_REMOTE_ID);
    expect(discordRows[0]?.chatRoomId).toBe(SHARED_REMOTE_ID);
    expect(whatsappRows[0]?.roomKey).toBe(whatsappKey);
    expect(discordRows[0]?.roomKey).toBe(discordKey);

    // Clear the fixture so the delivery pump below only sees its own rows.
    for (const row of [...whatsappRows, ...discordRows]) {
      OutboxService.markEnqueuedSent(row.id, null);
    }
    expect(OutboxService.pendingForRoom(whatsappKey, 'whatsapp', 10).every(row => row.state === 'sent')).toBe(true);
  });
});

describe('room scoped dual reads', () => {
  test('a transcript reads canonical and legacy rows but never another room', () => {
    const legacyRoom = `legacy-${run}`;
    const dualRoom = `dual-${run}`;
    const discordRoom = `discord-legacy-${run}`;
    const whatsappKey = canonicalRoomKey('whatsapp', legacyRoom);
    const discordRoomKey = canonicalRoomKey('discord', discordRoom);

    insertRoom(legacyRoom, 'whatsapp');
    insertRoom(dualRoom, 'whatsapp');
    insertRoom(discordRoom, 'discord');

    // A message filed under the canonical key.
    const keyedId = insertMessage({ chatRoomId: legacyRoom, platform: 'whatsapp', content: 'keyed message', roomKey: whatsappKey });
    // A pre-0022 message: no room key at all, only the raw provider room id.
    const unkeyedId = insertMessage({ chatRoomId: dualRoom, platform: 'whatsapp', content: 'legacy message', roomKey: whatsappKey });
    sqlite.query<never, [string]>(`UPDATE messages SET room_key = NULL WHERE id = ?`).run(String(unkeyedId));
    // A different room, on another platform, must stay out of both transcripts.
    const discordMessageId = insertMessage({ chatRoomId: discordRoom, platform: 'discord', content: 'discord message', roomKey: discordRoomKey });

    const byKey = fetchRoomTranscript(whatsappKey, { since: new Date(0), limit: 50 });
    expect(byKey.some(line => line.includes('keyed message'))).toBe(true);
    expect(byKey.some(line => line.includes('legacy message'))).toBe(false);
    expect(byKey.some(line => line.includes('discord message'))).toBe(false);

    // A legacy room (no canonical key on the message row) is still readable by key.
    const dualKey = canonicalRoomKey('whatsapp', dualRoom);
    expect(fetchRoomTranscript(dualKey, { since: new Date(0), limit: 50 }).some(line => line.includes('legacy message'))).toBe(true);

    // And the raw provider room id keeps working in both directions.
    expect(fetchRoomTranscript(legacyRoom, { since: new Date(0), limit: 50 }).some(line => line.includes('keyed message'))).toBe(true);
    expect(fetchRoomTranscript(dualRoom, { since: new Date(0), limit: 50 }).some(line => line.includes('legacy message'))).toBe(true);

    // The Discord room only ever sees its own history.
    const discordTranscript = fetchRoomTranscript(discordRoomKey, { since: new Date(0), limit: 50 });
    expect(discordTranscript.some(line => line.includes('discord message'))).toBe(true);
    expect(discordTranscript.some(line => line.includes('keyed message'))).toBe(false);

    sqlite.query<never, [string, string, string]>(`DELETE FROM messages WHERE id IN (?, ?, ?)`)
      .run(String(keyedId), String(unkeyedId), String(discordMessageId));
  });
});

describe('provider send isolation', () => {
  test('outbox delivery reaches only the provider that owns the room', async () => {
    const whatsapp = createProvider('whatsapp');
    const discord = createProvider('discord');
    const intervals: Array<() => void> = [];
    const timers = {
      setInterval: (callback: () => void) => {
        intervals.push(callback);
        return { id: `interval-${intervals.length}` };
      },
      clearInterval: () => {},
      setTimeout: () => ({ id: 'timeout' }),
      clearTimeout: () => {},
    } as unknown as AppRuntimeDeps['timers'];

    const runtime = new AppRuntime({
      providers: [whatsapp, discord],
      messageQueue: { enqueue: () => true, stop: () => {} },
      webhookServer: {
        registerSender: () => {},
        start: () => {},
        stop: () => {},
        registerReadinessCheck: () => () => {},
      },
      scheduler: { registerSender: () => {}, start: () => {}, stop: () => {} },
      digestService: { registerSender: () => {}, start: () => {}, stop: () => {} },
      timers,
      healthMonitor: { start: () => {}, stop: () => {} } as never,
    });

    const webhookJob = async (): Promise<WebhookDeliveryJob> => ({
      eventId: null,
      route: 'generic',
      source: 'test',
      text: 'outbox pump',
      destinations: [
        { chatRoomId: PUMP_ROOM, platform: 'whatsapp', roomKey: canonicalRoomKey('whatsapp', PUMP_ROOM) },
        { chatRoomId: PUMP_ROOM, platform: 'discord', roomKey: canonicalRoomKey('discord', PUMP_ROOM) },
      ],
      receivedAt: new Date().toISOString(),
    });

    // Start before enqueuing: in production the enqueuer is only registered
    // during start(), so a webhook can never reach it before the provider set
    // exists. The enqueuer refuses (accepted:false) rather than promising a
    // 202 for a delivery nothing can perform.
    await runtime.start();

    // Drive the durable enqueue path with the runtime's own webhook enqueuer.
    const enqueued: WebhookDeliveryJob = await webhookJob();
    const enqueuer = (runtime as unknown as { enqueueWebhook: (job: WebhookDeliveryJob, signal: AbortSignal) => Promise<{ accepted: boolean; deliveryId: string; acceptedAt: string }> }).enqueueWebhook;
    const result = await enqueuer(enqueued, new AbortController().signal);
    expect(result.accepted).toBe(true);
    expect(result.deliveryId.split(',')).toHaveLength(2);

    // Intervals: rate limiter, outbox pump, retention, media cleanup.
    intervals[1]?.();
    await new Promise(resolve => setTimeout(resolve, 25));
    await runtime.stop();

    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    expect(discord.sendMessage).toHaveBeenCalledTimes(1);
    // Providers receive the raw remote room id, never the canonical key.
    expect(whatsapp.sendMessage.mock.calls[0]?.[0]).toBe(PUMP_ROOM);
    expect(discord.sendMessage.mock.calls[0]?.[0]).toBe(PUMP_ROOM);
    expect(whatsapp.sendMessage.mock.calls[0]?.[0]).not.toContain('room:');
  });

  test('a row whose key belongs to another platform is never handed to a provider', async () => {
    const whatsapp = createProvider('whatsapp');
    const intervals: Array<() => void> = [];
    const timers = {
      setInterval: (callback: () => void) => {
        intervals.push(callback);
        return { id: `interval-${intervals.length}` };
      },
      clearInterval: () => {},
      setTimeout: () => ({ id: 'timeout' }),
      clearTimeout: () => {},
    } as unknown as AppRuntimeDeps['timers'];

    const corruptedId = OutboxService.enqueueText(
      'whatsapp',
      PUMP_ROOM,
      'corrupted target',
      [`outbox-corrupt-${run}`],
      { roomKey: canonicalRoomKey('discord', PUMP_ROOM) },
    );
    const corrupted = sqlite
      .query<{ state: string; lastError: string | null }, [string]>(
        'SELECT state, last_error AS lastError FROM message_outbox WHERE id = ?',
      )
      .get(corruptedId);
    expect(corrupted?.state).toBe('pending');

    const runtime = new AppRuntime({
      providers: [whatsapp],
      messageQueue: { enqueue: () => true, stop: () => {} },
      webhookServer: {
        registerSender: () => {},
        start: () => {},
        stop: () => {},
        registerReadinessCheck: () => () => {},
      },
      scheduler: { registerSender: () => {}, start: () => {}, stop: () => {} },
      digestService: { registerSender: () => {}, start: () => {}, stop: () => {} },
      timers,
      healthMonitor: { start: () => {}, stop: () => {} } as never,
    });

    await runtime.start();
    intervals[1]?.();
    await new Promise(resolve => setTimeout(resolve, 25));
    await runtime.stop();

    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    const failed = sqlite
      .query<{ state: string; lastError: string | null }, [string]>(
        'SELECT state, last_error AS lastError FROM message_outbox WHERE id = ?',
      )
      .get(corruptedId);
    expect(failed?.state).toBe('failed');
    expect(failed?.lastError).toContain('Refusing unsafe outbox target');
    sqlite.query<never, [string]>(`DELETE FROM message_outbox WHERE id = ?`).run(corruptedId);
  });
});

describe('webhook destinations', () => {
  beforeEach(() => {
    // One WhatsApp room, plus the same remote id registered on Discord, so both
    // the mismatch and the ambiguity guards are exercised.
    insertRoom(WHATSAPP_ONLY_ROOM, 'whatsapp');
    insertRoom(SHARED_REMOTE_ID, 'whatsapp');
    resolveCanonicalRoomKey('discord', SHARED_REMOTE_ID);
  });

  test('classifies registered platforms and rejects cross-platform guesses', () => {
    expect(platformsForRemoteRoomId(WHATSAPP_ONLY_ROOM)).toEqual(['whatsapp']);
    expect(platformsForRemoteRoomId(SHARED_REMOTE_ID).sort()).toEqual(['discord', 'whatsapp']);

    // A Discord destination for a room that only exists on WhatsApp.
    const mismatched = resolveRemoteRoomDestination(WHATSAPP_ONLY_ROOM, 'discord');
    expect(mismatched.ok).toBe(false);
    expect(mismatched.ok === false && mismatched.reason).toBe('platform_mismatch');
    // The matching platform resolves to its canonical key.
    const accepted = resolveRemoteRoomDestination(WHATSAPP_ONLY_ROOM, 'whatsapp');
    expect(accepted.ok).toBe(true);
    expect(accepted.ok && accepted.roomKey).toBe(canonicalRoomKey('whatsapp', WHATSAPP_ONLY_ROOM));
    // A remote id on two platforms without a platform is ambiguous, and an
    // unknown platform value is invalid.
    const ambiguous = resolveRemoteRoomDestination(SHARED_REMOTE_ID, null);
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.ok === false && ambiguous.reason).toBe('platform_ambiguous');
    expect(resolveRemoteRoomDestination(SHARED_REMOTE_ID, 'telegram').ok).toBe(false);
  });

  test('a mismatched platform is rejected with 400 and nothing is delivered', async () => {
    const send = mock(async (_roomId: string, _text: string) => {});
    const discordSend = mock(async (_roomId: string, _text: string) => {});
    await withWebhookServer(async (_server, baseUrl) => {
      const accepted = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': WEBHOOK_SECRET },
        body: JSON.stringify({ room_id: WHATSAPP_ONLY_ROOM, platform: 'whatsapp', text: 'hello' }),
      });
      expect(accepted.status).toBe(200);

      // The same remote id pinned to Discord crosses platforms: rejected.
      const mismatch = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': WEBHOOK_SECRET,
          'X-Webhook-Id': `mismatch-${run}`,
        },
        body: JSON.stringify({ room_id: WHATSAPP_ONLY_ROOM, platform: 'discord', text: 'hello' }),
      });
      expect(mismatch.status).toBe(400);
      expect(await mismatch.json()).toEqual({ error: 'Destination platform mismatch' });

      // Unknown platform values keep the pre-existing contract.
      const invalid = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': WEBHOOK_SECRET,
          'X-Webhook-Id': `invalid-${run}`,
        },
        body: JSON.stringify({ room_id: WHATSAPP_ONLY_ROOM, platform: 'telegram', text: 'hello' }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: 'Invalid platform' });
    }, server => {
      server.registerSender('whatsapp', send);
      server.registerSender('discord', discordSend);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(WHATSAPP_ONLY_ROOM);
    expect(discordSend).not.toHaveBeenCalled();
  });

  test('an ambiguous remote id without a platform is rejected with 400', async () => {
    const send = mock(async (_roomId: string, _text: string) => {});
    await withWebhookServer(async (_server, baseUrl) => {
      const response = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': WEBHOOK_SECRET,
          'X-Webhook-Id': `ambiguous-${run}`,
        },
        body: JSON.stringify({ room_id: SHARED_REMOTE_ID, text: 'hello' }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'Destination matches multiple platforms; specify platform',
      });
    }, server => server.registerSender('whatsapp', send));
    expect(send).not.toHaveBeenCalled();
  });

  test('a media destination is rejected when the subscription platform disagrees with the room', async () => {
    const send = mock(async (_roomId: string, _text: string) => {});
    const userSpy = spyOn(ServiceBindingService, 'findByExternalUser').mockResolvedValue([
      { id: 1, userId: 'user-1', platform: 'whatsapp' },
    ] as never);
    const roomsSpy = spyOn(NotificationSubscriptionService, 'getNotificationRooms').mockResolvedValue([
      { chatRoomId: WHATSAPP_ONLY_ROOM, roomKey: canonicalRoomKey('discord', WHATSAPP_ONLY_ROOM), platform: 'discord' },
    ] as never);
    const adminSpy = spyOn(NotificationSubscriptionService, 'getAdminNotificationRooms').mockResolvedValue([] as never);

    try {
      await withWebhookServer(async (_server, baseUrl) => {
        const response = await Bun.fetch(`${baseUrl}/webhook/jellyfin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': JELLYFIN_SECRET },
          body: JSON.stringify({ NotificationType: 'PlaybackStart', Name: 'Episode', UserId: 'jf-1' }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Destination platform mismatch' });
      }, server => server.registerSender('discord', send));
      expect(send).not.toHaveBeenCalled();
    } finally {
      userSpy.mockRestore();
      roomsSpy.mockRestore();
      adminSpy.mockRestore();
    }
  });

  test('readiness and liveness responses are unchanged by room key resolution', async () => {
    await withWebhookServer(async (server, baseUrl) => {
      const unregister = server.registerReadinessCheck(() => false);
      try {
        for (const path of ['/health', '/live']) {
          const response = await Bun.fetch(`${baseUrl}${path}`);
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ status: 'ok', version: APP_VERSION, releaseTag: APP_RELEASE_TAG });
        }
        const ready = await Bun.fetch(`${baseUrl}/ready`);
        expect(ready.status).toBe(503);
        expect(await ready.json()).toEqual({ status: 'not_ready', version: APP_VERSION, releaseTag: APP_RELEASE_TAG });
      } finally {
        unregister();
      }
    });
  });
});

describe('scheduled reminders', () => {
  const schedulerInternals = Scheduler as unknown as { processReminders(): Promise<void> };

  test('delivers to the raw provider room id stored behind a canonical key', async () => {
    insertRoom(WHATSAPP_JID, 'whatsapp');
    const key = resolveCanonicalRoomKey('whatsapp', WHATSAPP_JID);
    const reminderId = insertReminder(WHATSAPP_JID, key, 'Standup');
    const send = mock(async (_roomId: string, _text: string) => {});
    Scheduler.registerSender('whatsapp', send);

    try {
      await schedulerInternals.processReminders();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toBe(WHATSAPP_JID);
    } finally {
      Scheduler.unregisterSender('whatsapp');
      sqlite.query<never, [number]>(`DELETE FROM reminders WHERE id = ?`).run(reminderId);
    }
  });

  test('refuses to deliver a reminder stored under another platform key', async () => {
    insertRoom(SHARED_REMOTE_ID, 'whatsapp');
    // A row keyed for Discord but stored as WhatsApp must not be delivered.
    const reminderId = insertReminder(SHARED_REMOTE_ID, canonicalRoomKey('discord', SHARED_REMOTE_ID), 'Foreign');
    const send = mock(async (_roomId: string, _text: string) => {});
    Scheduler.registerSender('whatsapp', send);

    try {
      await schedulerInternals.processReminders();
      expect(send).not.toHaveBeenCalled();
    } finally {
      Scheduler.unregisterSender('whatsapp');
      sqlite.query<never, [number]>(`DELETE FROM reminders WHERE id = ?`).run(reminderId);
    }
  });
});
