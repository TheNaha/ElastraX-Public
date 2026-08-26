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
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { logger } from './logger';
import { getErrorMessage } from './errorUtils';
import { getModelRouter } from './ModelRouter';
import { MediaService } from './MediaService';
import { t, type Locale } from './i18n';

const log = logger.child({ module: 'DigestService' });

type SendFn = (chatRoomId: string, text: string) => Promise<void>;
type CallLLM = (prompt: string) => Promise<string>;
const SEND_TIMEOUT_MS = 15_000;

/** Injectable dependencies for tests (all optional). */
export interface DigestDeps {
  callLLM?: CallLLM;
  now?: () => Date;
  send?: (platform: string, chatRoomId: string, text: string) => Promise<void>;
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
  const hourRaw = parseInt(process.env.DIGEST_HOUR_UTC ?? '', 10);
  const lookbackRaw = parseInt(process.env.DIGEST_LOOKBACK_HOURS ?? '', 10);
  const maxRaw = parseInt(process.env.DIGEST_MAX_MESSAGES ?? '', 10);
  return {
    enabled: process.env.DIGEST_ENABLED === 'true',
    mediaEnabled: process.env.DIGEST_MEDIA_ENABLED === 'true',
    hourUtc: Number.isFinite(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? hourRaw : 8,
    rooms: (process.env.DIGEST_ROOMS ?? '')
      .split(',')
      .map(r => r.trim())
      .filter(Boolean),
    lookbackHours: Number.isFinite(lookbackRaw) && lookbackRaw > 0 ? lookbackRaw : 24,
    maxMessages: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 500,
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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`send timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ── Transcript building ───────────────────────────────────────────────────────

/**
 * Fetch up to `limit` messages for a room since `since`, oldest first,
 * formatted as "[HH:MM] Name: content".
 */
export function fetchRoomTranscript(
  roomId: string,
  opts: { since: Date; limit: number },
): string[] {
  const rows = db.select({
    senderName: messages.senderName,
    role: messages.role,
    content: messages.content,
    created_at: messages.created_at,
  })
    .from(messages)
    .where(and(eq(messages.chatRoomId, roomId), gte(messages.created_at, opts.since)))
    .orderBy(asc(messages.created_at))
    .limit(opts.limit)
    .all();

  const lines: string[] = [];
  for (const r of rows) {
    const text = (r.content ?? '').trim();
    if (!text) continue;
    const hh = String(r.created_at.getHours()).padStart(2, '0');
    const mm = String(r.created_at.getMinutes()).padStart(2, '0');
    const who = r.role === 'assistant' ? 'Bot' : r.senderName;
    lines.push(`[${hh}:${mm}] ${who}: ${text}`);
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
  opts: { hours: number; maxMessages: number; lang?: string | null; deps?: DigestDeps },
): Promise<{ text: string; messageCount: number } | null> {
  const since = new Date(Date.now() - opts.hours * 3_600_000);
  const transcript = fetchRoomTranscript(roomId, { since, limit: opts.maxMessages });
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

function platformForRoom(roomId: string): string {
  const row = db.select({ platform: chatRooms.platform })
    .from(chatRooms)
    .where(eq(chatRooms.id, roomId))
    .all()[0];
  return row?.platform ?? 'whatsapp';
}

function languageForRoom(roomId: string): Locale {
  const row = db.select({ language: chatRooms.language })
    .from(chatRooms)
    .where(eq(chatRooms.id, roomId))
    .all()[0];
  return localeFor(row?.language);
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

  /** Register a send callback for a given platform. */
  static registerSender(platform: string, fn: SendFn): void {
    this.senders.set(platform, fn);
    log.info({ platform }, '[DigestService] Sender registered');
  }

  /** Start the hourly-check polling loop (every 60 seconds). */
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
    if (now.getUTCHours() !== cfg.hourUtc) return 0;

    let sent = 0;
    for (const roomId of cfg.rooms) {
      const marker = `digest:daily:${roomId}:${dateKey(now)}`;
      if (!claimMarker(marker)) continue;
      try {
        const lang = languageForRoom(roomId);
        const result = await summarizeRoom(roomId, {
          hours: cfg.lookbackHours,
          maxMessages: cfg.maxMessages,
          lang,
          deps,
        });
        if (!result) {
          // Quiet room — keep the marker so we don't re-scan all day.
          log.debug({ roomId }, '[DigestService] Daily digest skipped (no messages)');
          continue;
        }
        const text = `${t(lang, 'digest.header', { hours: String(cfg.lookbackHours) })}\n\n${result.text}`;
        await this.deliver(platformForRoom(roomId), roomId, text, deps);
        sent++;
        log.info({ roomId, messages: result.messageCount }, '[DigestService] Daily digest delivered');
      } catch (err) {
        releaseMarker(marker);
        log.warn({ err: getErrorMessage(err), roomId }, '[DigestService] Daily digest failed — will retry');
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
    if (now.getUTCHours() !== cfg.hourUtc) return 0;

    const wk = weekKey(now);
    const weekStart = new Date(`${wk}T00:00:00.000Z`);

    // Fetch all jellyfin/seerr subscriptions, then apply the notifyTypes filter
    // in JS so null (all types), JSON arrays and raw strings are handled uniformly.
    const subs = db.select({
      chatRoomId: notificationSubscriptions.chatRoomId,
      notifyTypes: notificationSubscriptions.notifyTypes,
    })
      .from(notificationSubscriptions)
      .where(inArray(notificationSubscriptions.serviceType, ['jellyfin', 'seerr']))
      .all()
      .filter(s => wantsDigest(s.notifyTypes));

    const rooms = [...new Set(subs.map(s => s.chatRoomId))];
    let sent = 0;

    for (const roomId of rooms) {
      const marker = `digest:media:${roomId}:${wk}`;
      if (!claimMarker(marker)) continue;
      try {
        const text = await this.buildMediaRollup(weekStart, deps);
        if (!text) {
          // Nothing new this week — keep the marker, stay silent.
          log.debug({ roomId }, '[DigestService] Weekly media digest skipped (nothing new)');
          continue;
        }
        await this.deliver(platformForRoom(roomId), roomId, text, deps);
        sent++;
        log.info({ roomId }, '[DigestService] Weekly media digest delivered');
      } catch (err) {
        releaseMarker(marker);
        log.warn({ err: getErrorMessage(err), roomId }, '[DigestService] Weekly media digest failed — will retry');
      }
    }
    return sent;
  }

  /**
   * Format this week's newly-added Jellyfin items.
   * Returns null when the client is unconfigured (marker released → retried later)
   * or nothing new was added (marker kept → silent).
   */
  static async buildMediaRollup(weekStart: Date, _deps?: DigestDeps): Promise<string | null> {
    const client = MediaService.createJellyfinClient();
    if (!client.isConfigured) {
      throw new Error('Jellyfin is not configured (JELLYFIN_API_URL/JELLYFIN_API_KEY)');
    }

    const items = await client.getLatestMedia({ limit: 15 });
    const fresh = items.filter(item => {
      const created = item.DateCreated ? new Date(String(item.DateCreated)) : null;
      return !created || created.getTime() >= weekStart.getTime();
    });
    if (fresh.length === 0) return null;

    const emojiFor = (itemType: unknown): string => {
      const typeStr = String(itemType ?? '');
      if (typeStr === 'Movie') return '🎬';
      if (typeStr.startsWith('Episode') || typeStr === 'Series') return '📺';
      if (typeStr.startsWith('Music') || typeStr === 'Audio') return '🎵';
      return '•';
    };

    const lines = fresh.map(item => {
      const year = item.ProductionYear ? ` (${item.ProductionYear})` : '';
      const link = client.getWatchLink(item.Id);
      return `${emojiFor(item.Type)} ${item.Name}${year}\n   ${link}`;
    });

    return `${t('en', 'digest.media_header')}\n\n${lines.join('\n')}`;
  }

  private static async deliver(platform: string, roomId: string, text: string, deps?: DigestDeps): Promise<void> {
    if (deps?.send) {
      await withTimeout(deps.send(platform, roomId, text), SEND_TIMEOUT_MS);
      return;
    }
    const sender = this.senders.get(platform);
    if (!sender) throw new Error(`no sender registered for platform '${platform}'`);
    await withTimeout(sender(roomId, text), SEND_TIMEOUT_MS);
  }
}
