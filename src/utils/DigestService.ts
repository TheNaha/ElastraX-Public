/**
 * @file src/utils/DigestService.ts
 * @description Scheduled digests: nightly per-room conversation summaries and a
 *              weekly Jellyfin "new media" rollup, both delivered through the
 *              same provider-sender registry pattern as Scheduler.
 *
 * Exactly-once delivery is keyed on the `app_kv` table:
 *   digest:daily:<roomId>:<YYYY-MM-DD>     — one nightly summary per room/day
 *   digest:media:<roomId>:<weekStartDate>  — one weekly media rollup per room/week
 *
 * A marker is INSERTed (ON CONFLICT DO NOTHING) BEFORE sending; only the
 * winner of that insert delivers. On delivery failure the marker is deleted so
 * the next poll retries.
 *
 * Configuration (all optional — feature off unless enabled):
 *   DIGEST_ENABLED          'true' → nightly conversation digests
 *   DIGEST_MEDIA_ENABLED    'true' → weekly Jellyfin rollup
 *   DIGEST_HOUR_UTC         Hour (0-23) the daily checks fire (default 8)
 *   DIGEST_ROOMS            Comma-separated room ids for daily digests
 *                           (empty = no daily digests)
 *   DIGEST_LOOKBACK_HOURS   How far back the daily summary looks (default 24)
 *   DIGEST_MAX_MESSAGES     Max messages fed to the LLM per digest (default 500)
 *
 * Weekly media rooms come from `notification_subscriptions`
 * (serviceType jellyfin/seerr, notifyTypes null or containing 'digest').
 */

import { db } from '../db';
import { appKv, chatRooms, messages, notificationSubscriptions } from '../db/schema';
import { and, desc, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import { logger } from './logger';
import { getErrorMessage } from './errorUtils';
import { getModelRouter } from './ModelRouter';
import { MediaService } from './MediaService';
import { t, type Locale } from './i18n';
import {
  inferRoomPlatform,
  keyPlatformOf,
  normalizeRoomPlatform,
  remoteRoomIdFromKey,
  resolveRemoteRoom,
  type RoomPlatform,
} from '../messaging/roomKeys';

import { withCancellableTimeout } from './withTimeout.js';

const log = logger.child({ module: 'DigestService' });

type SendFn = (chatRoomId: string, text: string, signal?: AbortSignal) => Promise<void>;
type CallLLM = (prompt: string) => Promise<string>;
type JellyfinClient = ReturnType<typeof MediaService.createJellyfinClient>;
type JellyfinMediaItem = Awaited<ReturnType<JellyfinClient['getLatestMedia']>>[number];
const SEND_TIMEOUT_MS = 15_000;

/** Injectable dependencies for tests (all optional). */
export interface DigestDeps {
  callLLM?: CallLLM;
  now?: () => Date;
  send?: (platform: string, chatRoomId: string, text: string, signal?: AbortSignal) => Promise<void>;
}

interface DigestConfig {
  enabled: boolean;
  mediaEnabled: boolean;
  hourUtc: number;
  rooms: string[];
  lookbackHours: number;
  maxMessages: number;
}

function readDigestConfig(): DigestConfig {
  const hourRaw = Number(process.env.DIGEST_HOUR_UTC);
  const lookbackRaw = Number(process.env.DIGEST_LOOKBACK_HOURS);
  const maxRaw = Number(process.env.DIGEST_MAX_MESSAGES);
  return {
    enabled: process.env.DIGEST_ENABLED === 'true',
    mediaEnabled: process.env.DIGEST_MEDIA_ENABLED === 'true',
    hourUtc: Number.isFinite(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? hourRaw : 8,
    rooms: (process.env.DIGEST_ROOMS ?? '')
      .split(',')
      .map(r => r.trim())
      .filter(Boolean),
    lookbackHours: Number.isInteger(lookbackRaw) && lookbackRaw > 0 && lookbackRaw <= 720 ? lookbackRaw : 24,
    maxMessages: Number.isInteger(maxRaw) && maxRaw > 0 && maxRaw <= 1_000 ? maxRaw : 500,
  };
}

// ── app_kv exactly-once markers ───────────────────────────────────────────────

function claimMarker(id: string): boolean {
  const res = db.insert(appKv)
    .values({ id, value: new Date().toISOString(), updated_at: new Date() })
    .onConflictDoNothing()
    .run() as unknown as { changes: number };
  return res.changes > 0;
}

function releaseMarker(id: string): void {
  db.delete(appKv).where(eq(appKv.id, id)).run();
}

/** UTC date key (YYYY-MM-DD) for daily markers. */
export function dateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** UTC date key of the Monday starting `now`'s week — stable weekly markers. */
export function weekKey(now: Date): string {
  const utcMonday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)),
  );
  return dateKey(utcMonday);
}

// ── Transcript building ───────────────────────────────────────────────────────

/**
 * Room identifiers to read for one canonical room key: the key itself plus the
 * raw provider room id, so history written before the room was re-keyed stays
 * part of the digest (dual read).
 */
function roomIdCandidates(roomId: string): string[] {
  const value = roomId.trim();
  const ids = [value];
  const remote = remoteRoomIdFromKey(value);
  if (remote) ids.push(remote);
  return [...new Set(ids.filter(Boolean))];
}

type DigestRoom = {
  /** Canonical, platform-scoped room key used for queries and markers. */
  roomKey: string;
  /** Raw provider room id used for delivery. */
  remoteRoomId: string;
  platform: string;
};

function roomConfig(roomId: string): { platform: string; language: string | null } | null {
  for (const candidate of roomIdCandidates(roomId)) {
    const row = db.select({ platform: chatRooms.platform, language: chatRooms.language })
      .from(chatRooms)
      .where(eq(chatRooms.id, candidate))
      .all()[0];
    if (row) return { platform: row.platform, language: row.language ?? null };
  }
  const roomKey = roomId.trim();
  if (!remoteRoomIdFromKey(roomKey)) return null;
  // Canonical-keyed room rows: the legacy `chat_rooms.id` is the raw room id.
  const row = db.select({ platform: chatRooms.platform, language: chatRooms.language })
    .from(chatRooms)
    .where(eq(chatRooms.roomKey, roomKey))
    .all()[0];
  return row ? { platform: row.platform, language: row.language ?? null } : null;
}

/**
 * Translate a configured room (raw provider room id, an already canonical key,
 * or a stored `room_key`) into the canonical key plus the raw id used for
 * delivery.
 */
function resolveDigestRoom(roomId: string, platformHint?: string | null, roomKeyHint?: string | null): DigestRoom {
  const value = roomId.trim();
  const storedKey = roomKeyHint?.trim();
  if (storedKey && remoteRoomIdFromKey(storedKey)) {
    return {
      roomKey: storedKey,
      remoteRoomId: value,
      platform: normalizeRoomPlatform(platformHint) ?? keyPlatformOf(storedKey) ?? 'whatsapp',
    };
  }
  const remote = remoteRoomIdFromKey(value);
  const keyPlatform = keyPlatformOf(value);
  if (remote && keyPlatform) {
    return {
      roomKey: value,
      remoteRoomId: remote,
      platform: normalizeRoomPlatform(platformHint) ?? keyPlatform,
    };
  }
  const registered = roomConfig(value);
  const platform: string = normalizeRoomPlatform(platformHint)
    ?? inferRoomPlatform(value)
    ?? registered?.platform
    ?? 'whatsapp';
  return { roomKey: resolveRemoteRoom(platform, value).roomKey, remoteRoomId: value, platform };
}

/**
 * Scope a room read to one platform. `messages.platform` is nullable on rows
 * written by older lanes, so an unknown platform still matches.
 */
function platformScope(column: typeof messages.platform, platform: RoomPlatform | null) {
  if (!platform) return undefined;
  return or(isNull(column), eq(column, platform));
}

/**
 * Fetch up to `limit` messages for a room since `since`, oldest first,
 * formatted as "[HH:MM] Name: content".  Accepts a canonical room key or a raw
 * provider room id and reads both forms, scoped to the room's own platform so a
 * room key never picks up another platform's history.
 */
export function fetchRoomTranscript(
  roomId: string,
  opts: { since: Date; limit: number },
): string[] {
  const value = roomId.trim();
  const remote = remoteRoomIdFromKey(value);
  const platform = normalizeRoomPlatform(keyPlatformOf(value));
  const roomFilter = remote
    // Dual read: rows filed under the canonical key plus rows still addressed by
    // the raw provider room id.
    ? or(
      and(eq(messages.roomKey, value), platformScope(messages.platform, platform)),
      and(
        inArray(messages.chatRoomId, [value, remote]),
        platformScope(messages.platform, platform),
      ),
    )
    : eq(messages.chatRoomId, value);
  const rows = db.select({
    senderName: messages.senderName,
    role: messages.role,
    content: messages.content,
    created_at: messages.created_at,
  })
    .from(messages)
    .where(and(roomFilter, gte(messages.created_at, opts.since)))
    .orderBy(desc(messages.created_at))
    .limit(Math.max(1, Math.min(1_000, opts.limit)))
    .all()
    .reverse();

  const lines: string[] = [];
  let totalBytes = 0;
  for (const r of rows) {
    const text = (r.content ?? '').trim().slice(0, 2_000);
    if (!text) continue;
    const hh = String(r.created_at.getHours()).padStart(2, '0');
    const mm = String(r.created_at.getMinutes()).padStart(2, '0');
    const who = r.role === 'assistant' ? 'Bot' : 'Sender';
    const line = `[${hh}:${mm}] ${who}: ${text}`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (totalBytes + bytes > 500_000) break;
    totalBytes += bytes;
    lines.push(line);
  }
  return lines;
}

async function defaultCallLLM(prompt: string): Promise<string> {
  const msg = await getModelRouter().chatCompletion(
    [{ role: 'user', content: prompt }],
    undefined,
    0.2,
  );
  return typeof msg.content === 'string' ? msg.content : '';
}

function localeFor(lang: string | null | undefined): Locale {
  return lang === 'id' ? 'id' : 'en';
}

/**
 * Build an LLM digest for a room. Returns null when there is nothing to summarize.
 */
export async function summarizeRoom(
  roomId: string,
  opts: { hours: number; maxMessages: number; lang?: string | null; now?: Date; deps?: DigestDeps },
): Promise<{ text: string; messageCount: number } | null> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.hours * 3_600_000);
  // Queries run on the canonical room key (which also reads the raw-id rows).
  const transcript = fetchRoomTranscript(resolveDigestRoom(roomId).roomKey, { since, limit: opts.maxMessages });
  if (transcript.length === 0) return null;

  const callLLM = opts.deps?.callLLM ?? defaultCallLLM;
  const language = opts.lang === 'id' ? 'Indonesian' : 'English';
  const prompt = [
    `These are chat messages from the last ${opts.hours} hours.`,
    'Write a concise summary as short bullet points covering:',
    '- main topics discussed',
    '- decisions or conclusions reached',
    '- open questions or things people should follow up on',
    '- notable links/media shared',
    `Respond in ${language}. Keep it under 200 words. Do not invent events.`,
    '',
    '--- MESSAGES ---',
    ...transcript,
  ].join('\n');

  const summary = (await callLLM(prompt)).trim();
  if (!summary) return null;
  return { text: summary, messageCount: transcript.length };
}

// ── Platform/room helpers ─────────────────────────────────────────────────────

function languageForRoom(roomId: string): Locale {
  return localeFor(roomConfig(roomId)?.language);
}

/** True unless notifyTypes is set and does NOT include 'digest'. */
function wantsDigest(notifyTypesRaw: string | null): boolean {
  if (!notifyTypesRaw) return true;
  try {
    const parsed = JSON.parse(notifyTypesRaw);
    if (Array.isArray(parsed)) return parsed.includes('digest');
  } catch {
    // fall through to substring match
  }
  return notifyTypesRaw.includes('digest');
}

// ── Service ───────────────────────────────────────────────────────────────────

export class DigestService {
  private static senders = new Map<string, SendFn>();
  private static timer: ReturnType<typeof setInterval> | null = null;
  private static running = false;
  private static mediaCache: { weekStart: number; items: Promise<JellyfinMediaItem[]> } | null = null;

  /** Register a send callback for a given platform. */
  static registerSender(platform: string, fn: SendFn): void {
    this.senders.set(platform, fn);
    log.info({ platform }, '[DigestService] Sender registered');
  }

  /** Start the hourly-check polling loop (every 60 seconds). */
  static unregisterSender(platform: string): void {
    this.senders.delete(platform);
  }

  static start(): void {
    const cfg = readDigestConfig();
    if (!cfg.enabled && !cfg.mediaEnabled) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processDue().catch(err => {
        log.error({ err }, '[DigestService] Error in digest loop');
      });
    }, 60_000);
    log.info('[DigestService] Started (checking every 60s)');
  }

  static stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private static async processDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runDailyDigests();
      await this.runWeeklyMediaDigest();
    } finally {
      this.running = false;
    }
  }

  /**
   * Nightly per-room summaries. Returns the number of digests delivered.
   */
  static async runDailyDigests(deps?: DigestDeps): Promise<number> {
    const cfg = readDigestConfig();
    if (!cfg.enabled || cfg.rooms.length === 0) return 0;
    const now = deps?.now?.() ?? new Date();
    if (now.getUTCHours() < cfg.hourUtc) return 0;

    let sent = 0;
    for (const configuredRoom of cfg.rooms) {
      // Room config/markers/messages use the canonical key; delivery uses the
      // raw provider room id.
      const room = resolveDigestRoom(configuredRoom);
      const marker = `digest:daily:${room.roomKey}:${dateKey(now)}`;
      if (!claimMarker(marker)) continue;
      try {
        const lang = languageForRoom(room.roomKey);
        const result = await summarizeRoom(room.roomKey, {
          hours: cfg.lookbackHours,
          maxMessages: cfg.maxMessages,
          lang,
          now,
          deps,
        });
        if (!result) {
          // Quiet room — keep the marker so we don't re-scan all day.
          log.debug({ roomKey: room.roomKey, roomId: room.remoteRoomId }, '[DigestService] Daily digest skipped (no messages)');
          continue;
        }
        const text = `${t(lang, 'digest.header', { hours: String(cfg.lookbackHours) })}\n\n${result.text}`;
        await this.deliver(room.platform, room.remoteRoomId, text, deps);
        sent++;
        log.info({ roomKey: room.roomKey, roomId: room.remoteRoomId, messages: result.messageCount }, '[DigestService] Daily digest delivered');
      } catch (err) {
        releaseMarker(marker);
        log.warn({ err: getErrorMessage(err), roomKey: room.roomKey, roomId: room.remoteRoomId }, '[DigestService] Daily digest failed — will retry');
      }
    }
    return sent;
  }

  /**
   * Weekly Jellyfin rollup to subscribed rooms. Fires once per ISO week at
   * DIGEST_HOUR_UTC (first matching tick wins). Returns deliveries made.
   */
  static async runWeeklyMediaDigest(deps?: DigestDeps): Promise<number> {
    const cfg = readDigestConfig();
    if (!cfg.mediaEnabled) return 0;
    const now = deps?.now?.() ?? new Date();
    if (now.getUTCHours() < cfg.hourUtc) return 0;

    const wk = weekKey(now);
    const weekStart = new Date(`${wk}T00:00:00.000Z`);

    // Fetch all jellyfin/seerr subscriptions, then apply the notifyTypes filter
    // in JS so null (all types), JSON arrays and raw strings are handled uniformly.
    const subs = db.select({
      chatRoomId: notificationSubscriptions.chatRoomId,
      roomKey: notificationSubscriptions.roomKey,
      platform: notificationSubscriptions.platform,
      notifyTypes: notificationSubscriptions.notifyTypes,
    })
      .from(notificationSubscriptions)
      .where(inArray(notificationSubscriptions.serviceType, ['all', 'jellyfin', 'seerr']))
      .all()
      .filter(s => wantsDigest(s.notifyTypes));

    // The subscription platform is authoritative, so one remote id subscribed on
    // two platforms stays two separate rooms.
    const resolvedRooms = subs.map(sub => resolveDigestRoom(sub.chatRoomId, sub.platform, sub.roomKey));
    const rooms = [...new Map(resolvedRooms.map(room => [room.roomKey, room] as const)).values()];
    let sent = 0;

    for (const room of rooms) {
      const marker = `digest:media:${room.roomKey}:${wk}`;
      if (!claimMarker(marker)) continue;
      try {
        const lang = languageForRoom(room.roomKey);
        const text = await this.buildMediaRollup(weekStart, deps, lang);
        if (!text) {
          // Nothing new this week — keep the marker, stay silent.
          log.debug({ roomKey: room.roomKey }, '[DigestService] Weekly media digest skipped (nothing new)');
          continue;
        }
        await this.deliver(room.platform, room.remoteRoomId, text, deps);
        sent++;
        log.info({ roomKey: room.roomKey, roomId: room.remoteRoomId }, '[DigestService] Weekly media digest delivered');
      } catch (err) {
        releaseMarker(marker);
        log.warn({ err: getErrorMessage(err), roomKey: room.roomKey, roomId: room.remoteRoomId }, '[DigestService] Weekly media digest failed — will retry');
      }
    }
    return sent;
  }

  /**
   * Format this week's newly-added Jellyfin items.
   * Returns null when the client is unconfigured (marker released → retried later)
   * or nothing new was added (marker kept → silent).
   */
  static async buildMediaRollup(weekStart: Date, _deps?: DigestDeps, lang: Locale = 'en'): Promise<string | null> {
    const items = await this.loadWeeklyMedia(weekStart);
    return this.renderMediaRollup(items, lang);
  }

  private static loadWeeklyMedia(weekStart: Date): Promise<JellyfinMediaItem[]> {
    const key = weekStart.getTime();
    if (this.mediaCache?.weekStart === key) return this.mediaCache.items;
    const client = MediaService.createJellyfinClient();
    if (!client.isConfigured) {
      return Promise.reject(new Error('Jellyfin is not configured'));
    }
    const items = client.getLatestMedia({ limit: 15 })
      .then(media => media.filter(item => {
        const created = item.DateCreated ? new Date(String(item.DateCreated)) : null;
        return !created || created.getTime() >= weekStart.getTime();
      }))
      .catch(error => {
        this.mediaCache = null;
        throw error;
      });
    this.mediaCache = { weekStart: key, items };
    return items;
  }

  private static renderMediaRollup(items: JellyfinMediaItem[], lang: Locale): string | null {
    if (items.length === 0) return null;
    const client = MediaService.createJellyfinClient();
    const typeLabel = (itemType: unknown): string => {
      const value = String(itemType ?? '');
      if (value === 'Movie') return 'Film';
      if (value.startsWith('Episode') || value === 'Series') return 'Series';
      if (value.startsWith('Music') || value === 'Audio') return 'Audio';
      return 'Media';
    };
    const lines = items.map(item => {
      const year = item.ProductionYear ? ` (${item.ProductionYear})` : '';
      return `- ${typeLabel(item.Type)}: ${item.Name}${year}\n  ${client.getWatchLink(item.Id)}`;
    });
    return `${t(lang, 'digest.media_header')}\n\n${lines.join('\n')}`;
  }

  private static async deliver(platform: string, roomId: string, text: string, deps?: DigestDeps): Promise<void> {
    if (deps?.send) {
      await withCancellableTimeout(
        signal => deps.send!(platform, roomId, text, signal),
        SEND_TIMEOUT_MS,
        'digest send',
      );
      return;
    }
    const sender = this.senders.get(platform);
    if (!sender) throw new Error(`no sender registered for platform '${platform}'`);
    await withCancellableTimeout(
      signal => sender(roomId, text, signal),
      SEND_TIMEOUT_MS,
      'digest send',
    );
  }
}
