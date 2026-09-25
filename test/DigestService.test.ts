import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { createTempDatabase, type TempDatabase } from './helpers/database';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

import { appKv, chatRooms, messages, notificationSubscriptions } from '../src/db/schema';

// Own a real, migrated temp database behind the module mock so this file both
// works regardless of what other files mock, and cannot break them if the mock
// leaks: the replacement is a strict superset of the real module surface.
const database: TempDatabase = createTempDatabase();

// Mirrors src/db/runtime.ts exactly: the return value must be propagated,
// because callers such as claimInboxEvents rely on it.
function withImmediateTransaction<T>(sqlite: TempDatabase['sqlite'], operation: () => T): T {
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
}));

// Imported dynamically so the `../src/db` mock above is already registered.
const {
  DigestService,
  dateKey,
  weekKey,
  fetchRoomTranscript,
} = await import('../src/utils/DigestService');
type DigestDeps = Parameters<typeof DigestService.runDailyDigests>[0];
import { MediaService } from '../src/utils/MediaService';

const db = database.db;
const realCreateJellyfin = MediaService.createJellyfinClient;

const MEDIA_CLIENT_STATE: {
  configured: boolean;
  items: { Id: string; Name: string; Type?: string; ProductionYear?: number; DateCreated?: string }[];
} = { configured: true, items: [] };

const fakeJellyfinClient = {
  get isConfigured() {
    return MEDIA_CLIENT_STATE.configured;
  },
  getLatestMedia: async () => MEDIA_CLIENT_STATE.items,
  getWatchLink: (itemId: string) => `https://jf.example/web/index.html#!/details?id=${itemId}`,
};

const HOUR = 3_600_000;
/** 2026-08-26 is a Wednesday; 13:04 UTC. */
const WEDNESDAY_AFTERNOON = new Date('2026-08-26T13:04:00.000Z');

function dailyDeps(overrides: Partial<DigestDeps> = {}): DigestDeps & { sent: { platform: string; roomId: string; text: string }[] } {
  const sent: { platform: string; roomId: string; text: string }[] = [];
  return {
    sent,
    now: () => new Date(WEDNESDAY_AFTERNOON),
    send: async (platform: string, roomId: string, text: string) => {
      sent.push({ platform, roomId, text });
    },
    callLLM: async () => '• Topic A discussed\n• Decision B made',
    ...overrides,
  };
}

async function resetDatabase(): Promise<void> {
  await db.delete(appKv).run();
  await db.delete(notificationSubscriptions).run();
  await db.delete(messages).run();
  await db.delete(chatRooms).run();
}

async function seedRoom(id: string, platform: string, language = 'en'): Promise<void> {
  await db.insert(chatRooms).values({
    id,
    platform,
    language,
    systemPrompt: 'You are ElastraX.',
    created_at: new Date(),
  }).onConflictDoNothing().run();
}

async function seedMessage(
  chatRoomId: string,
  role: string,
  senderName: string,
  content: string,
  created_at: Date,
): Promise<void> {
  await db.insert(messages).values({
    chatRoomId,
    senderId: `${senderName}@s.whatsapp.net`,
    senderName,
    role,
    content,
    platform: 'whatsapp',
    providerMessageId: `pm-${Math.random().toString(36).slice(2, 12)}`,
    created_at,
  }).run();
}

async function seedSubscription(chatRoomId: string, notifyTypes: string | null): Promise<void> {
  const platform = chatRoomId.startsWith('dc-') ? 'discord' : 'whatsapp';
  await db.insert(notificationSubscriptions).values({
    userId: 'subscriber',
    platform,
    serviceType: 'jellyfin',
    chatRoomId,
    notifyTypes,
    created_at: new Date(),
  }).run();
}

beforeEach(async () => {
  await resetDatabase();
  MEDIA_CLIENT_STATE.configured = true;
  MEDIA_CLIENT_STATE.items = [];
  // The weekly rollup memoises one Jellyfin snapshot per ISO week; drop it so
  // each test observes a fresh fetch instead of the previous test's snapshot.
  (DigestService as unknown as { mediaCache: unknown }).mediaCache = null;
  (MediaService as unknown as { createJellyfinClient: unknown }).createJellyfinClient =
    () => fakeJellyfinClient;
  await seedRoom('room-1@g.us', 'whatsapp');
  // NOTE: summarizeRoom derives its window from Date.now() rather than the
  // injected clock, so "recent" rows are seeded relative to real time here.
  const now = Date.now();
  await seedMessage('room-1@g.us', 'user', 'Alice', 'movie night friday?', new Date(now - 3 * HOUR));
  await seedMessage('room-1@g.us', 'assistant', 'x', 'Sounds good!', new Date(now - 2 * HOUR));
  await seedMessage('room-1@g.us', 'user', 'Bob', '', new Date(now - 1 * HOUR));
});

afterAll(() => {
  database.cleanup();
  MediaService.createJellyfinClient = realCreateJellyfin;
});

describe('DigestService key functions', () => {
  test('dateKey formats a date in UTC', () => {
    expect(dateKey(new Date('2026-08-26T13:04:00Z'))).toBe('2026-08-26');
  });

  test('weekKey anchors to Monday', () => {
    expect(weekKey(new Date('2026-08-26T13:04:00Z'))).toBe('2026-08-24');
  });
});

describe('fetchRoomTranscript', () => {
  test('formats lines, anonymises senders, labels the bot, and drops empty messages', () => {
    const lines = fetchRoomTranscript('room-1@g.us', { since: new Date(0), limit: 100 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Sender: movie night friday?');
    expect(lines[0]).not.toContain('Alice');
    expect(lines[1]).toContain('Bot: Sounds good!');
  });

  test('respects the limit cap on rows read, before empty rows are dropped', () => {
    // Newest two rows are the empty user message and the bot reply, so only one
    // line survives the empty-content filter.
    const twoRows = fetchRoomTranscript('room-1@g.us', { since: new Date(0), limit: 2 });
    expect(twoRows).toHaveLength(1);
    expect(twoRows[0]).toContain('Bot: Sounds good!');

    // The single newest row is an empty user message, so it is read then dropped.
    expect(fetchRoomTranscript('room-1@g.us', { since: new Date(0), limit: 1 })).toEqual([]);
  });
});

describe('DigestService.runDailyDigests', () => {
  test('is a no-op when digests are disabled', async () => {
    delete process.env.DIGEST_ENABLED;
    const deps = dailyDeps();
    expect(await DigestService.runDailyDigests(deps)).toBe(0);
    expect(deps.sent).toHaveLength(0);
  });

  test('is a no-op when DIGEST_ROOMS is empty', async () => {
    process.env.DIGEST_ENABLED = 'true';
    process.env.DIGEST_ROOMS = '';
    const deps = dailyDeps();
    expect(await DigestService.runDailyDigests(deps)).toBe(0);
  });

  test('skips a room that has no messages at all', async () => {
    await seedRoom('quiet-room@g.us', 'whatsapp');
    process.env.DIGEST_ENABLED = 'true';
    process.env.DIGEST_ROOMS = 'quiet-room@g.us';
    process.env.DIGEST_HOUR_UTC = '8';
    const deps = dailyDeps({ now: () => new Date('2026-08-26T23:30:00.000Z') });
    expect(await DigestService.runDailyDigests(deps)).toBe(0);
  });

  test('sends a daily digest for rooms with recent activity', async () => {
    process.env.DIGEST_ENABLED = 'true';
    process.env.DIGEST_ROOMS = 'room-1@g.us';
    process.env.DIGEST_HOUR_UTC = '8';

    const deps = dailyDeps({ now: () => new Date('2026-08-26T23:30:00.000Z') });
    expect(await DigestService.runDailyDigests(deps)).toBe(1);
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.roomId).toBe('room-1@g.us');
    expect(deps.sent[0]!.platform).toBe('whatsapp');
    expect(deps.sent[0]!.text).toContain('Topic A discussed');
  });

  test('fires exactly once per day even on later ticks', async () => {
    process.env.DIGEST_ENABLED = 'true';
    process.env.DIGEST_ROOMS = 'room-1@g.us';
    process.env.DIGEST_HOUR_UTC = '8';

    const late = dailyDeps({ now: () => new Date('2026-08-26T23:30:00.000Z') });
    expect(await DigestService.runDailyDigests(late)).toBe(1);
    expect(await DigestService.runDailyDigests(dailyDeps({ now: () => new Date('2026-08-26T23:45:00.000Z') }))).toBe(0);
  });

  test('no-op before DIGEST_HOUR_UTC has been reached', async () => {
    process.env.DIGEST_ENABLED = 'true';
    process.env.DIGEST_ROOMS = 'room-1@g.us';
    process.env.DIGEST_HOUR_UTC = '13';
    const deps = dailyDeps({ now: () => new Date('2026-08-26T09:00:00.000Z') });
    expect(await DigestService.runDailyDigests(deps)).toBe(0);
    expect(deps.sent).toHaveLength(0);
  });

  test('rolls over to a new digest key on the next UTC day', async () => {
    process.env.DIGEST_ENABLED = 'true';
    process.env.DIGEST_ROOMS = 'room-1@g.us';
    process.env.DIGEST_HOUR_UTC = '8';

    expect(await DigestService.runDailyDigests(dailyDeps({ now: () => new Date('2026-08-26T23:30:00.000Z') }))).toBe(1);
    const nextDay = dailyDeps({ now: () => new Date('2026-08-27T09:00:00.000Z') });
    expect(await DigestService.runDailyDigests(nextDay)).toBe(1);
  });
});

describe('DigestService.runWeeklyMediaDigest', () => {
  beforeEach(async () => {
    await seedRoom('dc-room-2', 'discord');
    await seedRoom('dc-room-3', 'discord');
    process.env.DIGEST_MEDIA_ENABLED = 'true';
    process.env.DIGEST_HOUR_UTC = '13';
  });

  test('no-op when disabled or before the configured hour', async () => {
    delete process.env.DIGEST_MEDIA_ENABLED;
    expect(await DigestService.runWeeklyMediaDigest(dailyDeps())).toBe(0);

    process.env.DIGEST_MEDIA_ENABLED = 'true';
    const deps = dailyDeps({ now: () => new Date('2026-08-26T09:00:00.000Z') });
    expect(await DigestService.runWeeklyMediaDigest(deps)).toBe(0);
    expect(deps.sent).toHaveLength(0);
  });

  test('delivers fresh items to subscribed rooms and skips opted-out ones', async () => {
    MEDIA_CLIENT_STATE.items = [
      { Id: 'i1', Name: 'Fresh Movie', Type: 'Movie', ProductionYear: 2026, DateCreated: '2026-08-25T10:00:00Z' },
      { Id: 'i2', Name: 'Old Movie', Type: 'Movie', ProductionYear: 2021, DateCreated: '2026-01-01T00:00:00Z' },
    ];
    await seedSubscription('room-1@g.us', null);
    await seedSubscription('dc-room-1', JSON.stringify(['play']));
    await seedSubscription('dc-room-2', JSON.stringify(['digest', 'play']));
    await seedSubscription('dc-room-3', null);

    const deps = dailyDeps();
    expect(await DigestService.runWeeklyMediaDigest(deps)).toBe(3); // room-1 + dc-room-2 + dc-room-3 (dc-room-1 opted out)

    const room1 = deps.sent.find(s => s.roomId === 'room-1@g.us')!;
    expect(room1.platform).toBe('whatsapp');
    expect(room1.text).toContain('New this week on Jellyfin');
    expect(room1.text).toContain('Film: Fresh Movie (2026)');
    expect(room1.text).toContain('https://jf.example/web/index.html#!/details?id=i1');
    expect(room1.text).not.toContain('Old Movie');

    const dcRoom2 = deps.sent.find(s => s.roomId === 'dc-room-2')!;
    expect(dcRoom2.platform).toBe('discord');
    expect(deps.sent.some(s => s.roomId === 'dc-room-1')).toBe(false);
  });

  test('sends nothing when Jellyfin has no new items this week', async () => {
    await seedSubscription('room-1@g.us', null);
    const deps = dailyDeps();
    expect(await DigestService.runWeeklyMediaDigest(deps)).toBe(0);
    expect(deps.sent).toHaveLength(0);
  });

  test('is a no-op when Jellyfin is not configured', async () => {
    MEDIA_CLIENT_STATE.configured = false;
    await seedSubscription('room-1@g.us', null);
    expect(await DigestService.runWeeklyMediaDigest(dailyDeps())).toBe(0);
  });

  test('unconfigured Jellyfin releases markers so it retries on the next tick', async () => {
    MEDIA_CLIENT_STATE.configured = false;
    await seedSubscription('room-1@g.us', null);
    const first = dailyDeps();
    expect(await DigestService.runWeeklyMediaDigest(first)).toBe(0);

    MEDIA_CLIENT_STATE.configured = true;
    MEDIA_CLIENT_STATE.items = [
      { Id: 'i9', Name: 'Late Add', Type: 'Movie', ProductionYear: 2026, DateCreated: '2026-08-25T12:00:00Z' },
    ];
    const second = dailyDeps();
    expect(await DigestService.runWeeklyMediaDigest(second)).toBe(1);
  });

  test('does not resend to a room that already received this week', async () => {
    MEDIA_CLIENT_STATE.items = [
      { Id: 'i1', Name: 'Fresh Movie', Type: 'Movie', ProductionYear: 2026, DateCreated: '2026-08-25T10:00:00Z' },
    ];
    await seedSubscription('room-1@g.us', null);

    expect(await DigestService.runWeeklyMediaDigest(dailyDeps())).toBe(1);
    const second = dailyDeps();
    expect(await DigestService.runWeeklyMediaDigest(second)).toBe(0);
    expect(second.sent).toHaveLength(0);
  });

  test('exposes the injected now() and send() for the weekly rollup', async () => {
    await seedSubscription('room-1@g.us', null);
    const deps = dailyDeps({
      now: () => new Date(WEDNESDAY_AFTERNOON.getTime() - 7 * 24 * HOUR),
      send: async () => { throw new Error('send should not run without new media'); },
    });
    expect(await DigestService.runWeeklyMediaDigest(deps)).toBe(0);
  });
});
