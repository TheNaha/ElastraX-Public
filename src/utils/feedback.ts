/**
 * @file src/utils/feedback.ts
 * @description Thumbs up/down feedback on bot replies.
 *
 * Both providers already *send* reactions, but neither listened for incoming
 * ones, so the cheapest quality signal available — a user telling us the answer
 * was good or bad — was being discarded. This records it two ways:
 *
 *  - a Prometheus counter, so a regression shows up as a falling ratio
 *  - an append-only JSONL eval log, so the actual cases can be read and judged
 *
 * Only reactions to messages the bot itself sent are attributed. That is
 * tracked in a bounded recent-send index rather than a database lookup, because
 * a reaction arrives long after the send and the hot path should not hit the DB.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { healthMetrics } from './HealthMetrics';
import { logger } from './logger';
import { getErrorMessage } from './errorUtils';

const log = logger.child({ module: 'Feedback' });

export type FeedbackSentiment = 'positive' | 'negative';

/** Reaction glyphs that carry a clear verdict. Everything else is ignored. */
const POSITIVE = new Set(['\u{1F44D}', '\u2764\uFE0F', '\u2764', '\u{1F60D}', '\u{1F44C}', '\u{1F550}']);
const NEGATIVE = new Set(['\u{1F44E}', '\u{1F621}', '\u{1F614}', '\u{1F612}', '\u26A0']);

/** How many sent-message ids to remember for attribution. */
const RECENT_SEND_CAPACITY = 500;

export function classifyReaction(emoji: string): FeedbackSentiment | null {
  const glyph = emoji.trim();
  if (POSITIVE.has(glyph)) return 'positive';
  if (NEGATIVE.has(glyph)) return 'negative';
  return null;
}

export type FeedbackConfig = {
  enabled: boolean;
  logPath: string;
  maxSentimentPerDay: number;
};

export function readFeedbackConfig(env: NodeJS.ProcessEnv = process.env): FeedbackConfig {
  return {
    // Metrics are always collected; the eval log is opt-out and defaults on,
    // because a counter without the underlying cases is not actionable.
    enabled: !/^(0|false|no|off)$/i.test((env.FEEDBACK_LOG_ENABLED ?? '').trim()),
    logPath: resolve(env.FEEDBACK_LOG_PATH ?? 'data/feedback.jsonl'),
    maxSentimentPerDay: Number.isSafeInteger(Number(env.FEEDBACK_MAX_PER_DAY))
      ? Math.max(1, Number(env.FEEDBACK_MAX_PER_DAY))
      : 2_000,
  };
}

/**
 * Bounded set of recently sent message ids, so a reaction can be attributed to
 * the bot without a database lookup. Insertion-ordered, which gives a cheap
 * approximate FIFO eviction.
 */
class RecentSendIndex {
  private readonly ids = new Set<string>();
  constructor(private readonly capacity: number = RECENT_SEND_CAPACITY) {}

  add(platform: string, messageId: string): void {
    if (!messageId) return;
    const key = `${platform}:${messageId}`;
    this.ids.add(key);
    while (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next();
      if (oldest.done) break;
      this.ids.delete(oldest.value);
    }
  }

  has(platform: string, messageId: string): boolean {
    return messageId ? this.ids.has(`${platform}:${messageId}`) : false;
  }

  get size(): number {
    return this.ids.size;
  }

  clear(): void {
    this.ids.clear();
  }
}

const recentSends = new RecentSendIndex();

/** Record a message the bot just sent, so reactions to it can be attributed. */
export function noteBotMessageSent(platform: string, messageId: string | null | undefined): void {
  recentSends.add(platform, messageId ?? '');
}

export function isRecentBotMessage(platform: string, messageId: string | null | undefined): boolean {
  return recentSends.has(platform, messageId ?? '');
}

export function recentSendIndexSize(): number {
  return recentSends.size;
}

/** Test seam. */
export function resetRecentSendIndex(): void {
  recentSends.clear();
}

/** Test seam: clears the per-day volume counter. */
export function resetFeedbackDayCounts(): void {
  dayCounts.clear();
}

export type FeedbackEvent = {
  platform: string;
  chatRoomId: string;
  messageId: string;
  reaction: string;
  sentiment: FeedbackSentiment;
  /** True when the reaction was withdrawn. */
  removed: boolean;
  at: string;
};

const dayCounts = new Map<string, number>();

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function writeEvalLog(event: FeedbackEvent, config: FeedbackConfig): void {
  if (!config.enabled) return;
  try {
    mkdirSync(dirname(config.logPath), { recursive: true });
    // Append-only and line-delimited: a crash mid-write can lose the last line
    // but never corrupts earlier ones, and the file is greppable.
    // Sync append: this is off the latency path and ordering stays trivial.
    appendFileSync(config.logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
  } catch (error: unknown) {
    log.warn({ err: getErrorMessage(error) }, 'Failed to append feedback event');
  }
}

export type FeedbackOutcome =
  | { recorded: true; sentiment: FeedbackSentiment }
  | { recorded: false; reason: string };

/**
 * Record feedback for a reaction. Reactions to anything other than a recent bot
 * message, and ambiguous glyphs, are ignored rather than guessed at.
 */
export function recordReactionFeedback(input: {
  platform: string;
  chatRoomId: string;
  messageId: string | null | undefined;
  reaction: string;
  removed?: boolean;
  config?: FeedbackConfig;
  now?: Date;
}): FeedbackOutcome {
  const config = input.config ?? readFeedbackConfig();
  if (!config.enabled) return { recorded: false, reason: 'feedback logging disabled' };

  const sentiment = classifyReaction(input.reaction);
  if (sentiment === null) return { recorded: false, reason: 'reaction carries no verdict' };

  if (!isRecentBotMessage(input.platform, input.messageId)) {
    return { recorded: false, reason: 'reaction is not on a recent bot message' };
  }

  const now = input.now ?? new Date();
  const day = dayKey(now);
  for (const key of [...dayCounts.keys()]) {
    if (key !== day) dayCounts.delete(key);
  }
  const count = dayCounts.get(day) ?? 0;
  if (count >= config.maxSentimentPerDay) {
    return { recorded: false, reason: 'daily feedback log limit reached' };
  }
  dayCounts.set(day, count + 1);

  const event: FeedbackEvent = {
    platform: input.platform,
    chatRoomId: input.chatRoomId,
    messageId: input.messageId ?? '',
    reaction: input.reaction,
    sentiment,
    removed: input.removed === true,
    at: now.toISOString(),
  };

  healthMetrics.recordFeedback(sentiment, event.removed);
  writeEvalLog(event, config);
  log.debug({ sentiment, platform: input.platform, removed: event.removed }, 'Recorded reaction feedback');
  return { recorded: true, sentiment };
}
