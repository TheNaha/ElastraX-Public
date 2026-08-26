import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

// ── Configurable state ────────────────────────────────────────────────────────
// Route queries by REAL table identity — no schema mock (schema.ts is
// side-effect-free), which keeps this file from polluting shared workers.
import { appKv, chatRooms, messages, notificationSubscriptions } from '../src/db/schema';

let kvIds = new Set<string>();
let lastKvId: string | null = null;
let roomRows: { id: string; platform: string; language: string }[] = [];
let messageRows: { senderName: string; role: string; content: string; created_at: Date }[] = [];
let subRows: { chatRoomId: string; notifyTypes: string | null }[] = [];

const MEDIA_CLIENT_STATE: {
  configured: boolean;
  items: { Id: string; Name: string; Type?: string; ProductionYear?: number; DateCreated?: string }[];
} = { configured: true, items: [] };

/** Walks a drizzle condition object collecting candidate strings, then
 *  returns the one that is actually a known room id (skips column names). */
function extractRoomId(node: unknown, depth = 0): string | null {
  const strings: string[] = [];
  const walk = (n: unknown, d: number): void => {
    if (d > 8 || n === null || typeof n !== 'object') {
      if (typeof n === 'string') strings.push(n);
      return;
    }
    if (typeof n === 'string') {
      strings.push(n);
      return;
    }
    for (const value of Object.values(n as Record<string, unknown>)) walk(value, d + 1);
  };
  walk(node, depth);
  const knownIds = new Set([...roomRows.map(r => r.id), ...subRows.map(s => s.chatRoomId)]);
  return strings.find(s => knownIds.has(s)) ?? null;
}

mock.module('../src/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: (...whereArgs: unknown[]) => ({
          orderBy: () => ({
            limit: (n: number) => ({
              all: () => {
                if (table !== messages) return [];
                return messageRows.slice(0, n);
              },
            }),
          }),
          all: () => {
            if (table === chatRooms) {
              const id = extractRoomId(whereArgs[0]);
              return roomRows.filter(r => r.id === id);
            }
            if (table === notificationSubscriptions) return subRows;
            return [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (vals: { id: string }) => ({
        onConflictDoNothing: () => ({
          run: () => {
            const added = !kvIds.has(vals.id);
            if (added) kvIds.add(vals.id);
            lastKvId = vals.id;
            return { changes: added ? 1 : 0 };
          },
        }),
      }),
    }),
    // releaseMarker(id) always follows a claim of the same marker in these
    // flows, so removing the most-recently claimed id models the real thing.
    delete: () => ({
      where: () => ({
        run: () => {
          if (lastKvId !== null) kvIds.delete(lastKvId);
        },
      }),
    }),
  },
}));

import {
  DigestService,
  dateKey,
  weekKey,
  fetchRoomTranscript,
  type DigestDeps,
} from '../src/utils/DigestService';
import { MediaService } from '../src/utils/MediaService';

const realCreateJellyfin = MediaService.createJellyfinClient;
const fakeJellyfinClient = {
  get isConfigured() {
    return MEDIA_CLIENT_STATE.configured;
  },
  getLatestMedia: async () => MEDIA_CLIENT_STATE.items,
  getWatchLink: (itemId: string) => `https://jf.example/web/index.html#!/details?id=${itemId}`,
};

const HOUR = 3_600_000;
/** 2026-08-26 is a Wednesday; 13:00 UTC. */
const WEDNESDAY_NOON = new Date('2026-08-26T13:04:00.000Z');

function dailyDeps(overrides: Partial<DigestDeps> = {}): DigestDeps & { sent: { platform: string; roomId: string; text: string }[] } {
  const sent: { platform: string; roomId: string; text: string }[] = [];
  return {
    sent,
    now: () => new Date(WEDNESDAY_NOON),
    send: async (platform: string, roomId: string, text: string) => {
      sent.push({ platform, roomId, text });
    },
    callLLM: async () => '• Topic A discussed\n• Decision B made',
    ...overrides,
  };
}

beforeEach(() => {
  kvIds = new Set();
  lastKvId = null;
  roomRows = [{ id: 'room-1@g.us', platform: 'whatsapp', language: 'en' }];
  messageRows = [
    { senderName: 'Alice', role: 'user', content: 'movie night friday?', created_at: new Date('2026-08-26T09:05:00Z') },
    { senderName: 'x', role: 'assistant', content: 'Sounds good!', created_at: new Date('2026-08-26T09:06:00Z') },
    { senderName: 'Bob', role: 'user', content: '', created_at: new Date('2026-08-26T09:07:00Z') },
  ];
  subRows = [];
  MEDIA_CLIENT_STATE.configured = true;
  MEDIA_CLIENT_STATE.items = [];
  // Assignment patch (restored below) — same pattern other media-tool tests use.
  (MediaService as unknown as { createJellyfinClient: unknown }).createJellyfinClient =
    () => fakeJellyfinClient;
});

afterEach(() => {
  (MediaService as unknown as { createJellyfinClient: unknown }).createJellyfinClient =
    realCreateJellyfin;
});

describe('dateKey / weekKey', () => {
  test('dateKey is YYYY-MM-DD UTC', () => {
    expect(dateKey(new Date('2026-08-26T15:30:00Z'))).toBe('2026-08-26');
  });

  test('weekKey returns the Monday that starts the week', () => {
    // Wed Aug 26 2026 → Mon Aug 24 2026
    expect(weekKey(new Date('2026-08-26T13:00:00Z'))).toBe('2026-08-24');
    // Sunday Aug 23 belongs to the week starting Mon Aug 17
    expect(weekKey(new Date('2026-08-23T22:00:00Z'))).toBe('2026-08-17');
  });
});

describe('fetchRoomTranscript', () => {
  test('formats lines, labels bot, drops empty messages', () => {
    const lines = fetchRoomTranscript('room-1@g.us', { since: new Date(0), limit: 100 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Alice: movie night friday?');
    expect(lines[1]).toContain('Bot: Sounds good!');
  });

  test('respects the limit cap', () => {
    const lines = fetchRoomTranscript('room-1@g.us', { since: new Date(0), limit: 1 });
    expect(lines).toHaveLength(1);
  });
});

describe('DigestService.runDailyDigests', () => {
  test('no-op when disabled', async () => {
    delete process.env.DIGEST_ENABLED;
    process.env.DIGEST_ROOMS = 'room-1@g.us';
    const deps = dailyDeps();
    expect(await DigestService.runDailyDigests(deps)).toBe(0);
    expect(deps.sent).toHaveLength(0);
  });

  test('no-op outside DIGEST_HOUR_UTC', async () => {
    process.env.DIGEST_ENABLED = 'true';
    process.env.DIGEST_ROOMS = 'room-1@g.us';
    process.env.DIGEST_HOUR_UTC = '8';
    const deps = dailyDeps({ now: () => new Date('2026-08-26T09:00:00.000Z') }); // 09:xx UTC ≠ hour 8
    expect(await DigestService.runDailyDigests(deps)).toBe(0);
    expect(deps.sent).toHaveLength(0);
  });

  test('delivers exactly-once per room/day at the configured hour', async () => {
    process.env.DIGEST_ENABLED = 'true';
    process.env.DIGEST_ROOMS = 'room-1@g.us';
    process.env.DIGEST_HOUR_UTC = '13';

    const deps = dailyDeps();
    expect(await DigestService.runDailyDigests(deps)).toBe(1);
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.platform).toBe('whatsapp');
    expect(deps.sent[0]!.text).toContain('Summary of the last 24h');
    expect(deps.sent[0]!.text).toContain('Decision B made');

    // Same day again → marker blocks.
    expect(await DigestService.runDailyDigests(dailyDeps())).toBe(0);

    // Next day → fires again.
    const nextDay = dailyDeps({ now: () => new Date('2026-08-27T13:10:00.000Z') });
    expect(await DigestService.runDailyDigests(nextDay)).toBe(1);
  });

  test('quiet room stays silent but keeps its marker', async () => {
    process.env.DIGEST_ENABLED = 'true';
    process.env.DIGEST_ROOMS = 'room-1@g.us';
    process.env.DIGEST_HOUR_UTC = '13';
    messageRows = [];

    const deps = dailyDeps();
    expect(await DigestService.runDailyDigests(deps)).toBe(0);
    expect(deps.sent).toHaveLength(0);
    // Marker retained → no re-scan later the same day.
    expect(await DigestService.runDailyDigests(dailyDeps())).toBe(0);
  });

  test('LLM failure releases the marker so delivery retries', async () => {
    process.env.DIGEST_ENABLED = 'true';
    process.env.DIGEST_ROOMS = 'room-1@g.us';
    process.env.DIGEST_HOUR_UTC = '13';

    let fail = true;
    const failing = dailyDeps({
      callLLM: async () => {
        if (fail) throw new Error('provider down');
        return 'ok summary';
      },
    });
    expect(await DigestService.runDailyDigests(failing)).toBe(0);
    expect(failing.sent).toHaveLength(0);

    fail = false;
    const retry = dailyDeps();
    expect(await DigestService.runDailyDigests(retry)).toBe(1);
    expect(retry.sent).toHaveLength(1);
  });
});

describe('DigestService.runWeeklyMediaDigest', () => {
  beforeEach(() => {
    subRows = [
      { chatRoomId: 'room-1@g.us', notifyTypes: null },
      { chatRoomId: 'dc-room-1', notifyTypes: JSON.stringify(['play']) }, // opted out
      { chatRoomId: 'dc-room-2', notifyTypes: JSON.stringify(['digest', 'play']) },
      { chatRoomId: 'dc-room-3', notifyTypes: null },
    ];
    roomRows.push(
      { id: 'dc-room-2', platform: 'discord', language: 'en' },
      { id: 'dc-room-3', platform: 'discord', language: 'en' },
    );
    process.env.DIGEST_MEDIA_ENABLED = 'true';
    process.env.DIGEST_HOUR_UTC = '13';
  });

  test('no-op when disabled or wrong hour', async () => {
    delete process.env.DIGEST_MEDIA_ENABLED;
    expect(await DigestService.runWeeklyMediaDigest(dailyDeps())).toBe(0);

    process.env.DIGEST_MEDIA_ENABLED = 'true';
    const deps = dailyDeps({ now: () => new Date('2026-08-26T20:00:00.000Z') });
    expect(await DigestService.runWeeklyMediaDigest(deps)).toBe(0);
    expect(deps.sent).toHaveLength(0);
  });

  test('delivers fresh items once per week to opted-in rooms only', async () => {
    MEDIA_CLIENT_STATE.items = [
      { Id: 'i1', Name: 'Fresh Movie', Type: 'Movie', ProductionYear: 2026, DateCreated: '2026-08-25T10:00:00Z' },
      { Id: 'i2', Name: 'Old Movie', Type: 'Movie', ProductionYear: 1999, DateCreated: '2026-01-01T10:00:00Z' },
    ];

    const deps = dailyDeps();
    expect(await DigestService.runWeeklyMediaDigest(deps)).toBe(3); // room-1 + dc-room-2 + dc-room-3 (dc-room-1 opted out)
    const room1 = deps.sent.find(s => s.roomId === 'room-1@g.us')!;
    expect(room1.platform).toBe('whatsapp');
    expect(room1.text).toContain('New this week on Jellyfin');
    expect(room1.text).toContain('🎬 Fresh Movie (2026)');
    expect(room1.text).not.toContain('Old Movie');

    const dc2 = deps.sent.find(s => s.roomId === 'dc-room-2')!;
    expect(dc2.platform).toBe('discord');
    expect(deps.sent.find(s => s.roomId === 'dc-room-1')).toBeUndefined();

    // Same week again → markers block everything.
    expect(await DigestService.runWeeklyMediaDigest(dailyDeps())).toBe(0);
  });

  test('nothing new this week → silent, markers kept', async () => {
    MEDIA_CLIENT_STATE.items = [
      { Id: 'i2', Name: 'Old Movie', Type: 'Movie', DateCreated: '2026-01-01T10:00:00Z' },
    ];
    const deps = dailyDeps();
    expect(await DigestService.runWeeklyMediaDigest(deps)).toBe(0);
    expect(deps.sent).toHaveLength(0);
    expect(await DigestService.runWeeklyMediaDigest(dailyDeps())).toBe(0);
  });

  test('unconfigured Jellyfin releases markers so it retries next tick', async () => {
    MEDIA_CLIENT_STATE.items = [
      { Id: 'i1', Name: 'Fresh Movie', Type: 'Movie', DateCreated: '2026-08-25T10:00:00Z' },
    ];
    MEDIA_CLIENT_STATE.configured = false;

    expect(await DigestService.runWeeklyMediaDigest(dailyDeps())).toBe(0);

    MEDIA_CLIENT_STATE.configured = true;
    const deps = dailyDeps();
    expect(await DigestService.runWeeklyMediaDigest(deps)).toBe(3);
    expect(deps.sent).toHaveLength(3);
  });
});
