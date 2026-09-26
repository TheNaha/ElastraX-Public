/**
 * Tests for reaction feedback recording.
 *
 * The property that matters most is negative: a reaction must never be
 * attributed to the bot unless the bot actually sent that message. Guessing
 * wrong would poison the quality signal with other people's 👍s, so the
 * attribution check is exercised from several angles.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getTestWorkerPaths } from './helpers/paths';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

const { healthMetrics } = await import('../src/utils/HealthMetrics');
const {
  classifyReaction,
  readFeedbackConfig,
  noteBotMessageSent,
  isRecentBotMessage,
  recentSendIndexSize,
  resetRecentSendIndex,
  resetFeedbackDayCounts,
  recordReactionFeedback,
} = await import('../src/utils/feedback');

const LOG_DIR = join(getTestWorkerPaths().root, 'feedback');
const LOG_PATH = join(LOG_DIR, 'feedback.jsonl');
const config = { enabled: true, logPath: LOG_PATH, maxSentimentPerDay: 100 };

function baselineMetrics(): { positive: number; negative: number } {
  const m = healthMetrics.getMetrics();
  return { positive: m.feedback.positive, negative: m.feedback.negative };
}

beforeEach(() => {
  resetRecentSendIndex();
  resetFeedbackDayCounts();
  rmSync(LOG_DIR, { recursive: true, force: true });
});

describe('classifyReaction', () => {
  test('recognises clear positive glyphs', () => {
    for (const glyph of ['\u{1F44D}', '\u2764\uFE0F', '\u2764', '\u{1F60D}']) {
      expect(classifyReaction(glyph)).toBe('positive');
    }
  });

  test('recognises clear negative glyphs', () => {
    for (const glyph of ['\u{1F44E}', '\u{1F621}', '\u{1F614}', '\u{1F612}']) {
      expect(classifyReaction(glyph)).toBe('negative');
    }
  });

  test('ignores ambiguous and decorative glyphs', () => {
    // A fire emoji is engagement, not a verdict; recording it would dilute the
    // ratio with noise.
    for (const glyph of ['\u{1F525}', '\u{1F389}', 'eyes', '', '  ']) {
      expect(classifyReaction(glyph)).toBeNull();
    }
  });
});

describe('readFeedbackConfig', () => {
  test('is enabled with a default log path', () => {
    const defaults = readFeedbackConfig({} as NodeJS.ProcessEnv);
    expect(defaults.enabled).toBe(true);
    expect(defaults.logPath).toMatch(/feedback\.jsonl$/);
  });

  test('honours an explicit disable', () => {
    expect(readFeedbackConfig({ FEEDBACK_LOG_ENABLED: 'false' } as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  test('bounds the daily volume from env', () => {
    expect(readFeedbackConfig({ FEEDBACK_MAX_PER_DAY: '5' } as NodeJS.ProcessEnv).maxSentimentPerDay).toBe(5);
    expect(readFeedbackConfig({ FEEDBACK_MAX_PER_DAY: '0' } as NodeJS.ProcessEnv).maxSentimentPerDay).toBe(1);
  });
});

describe('recent send attribution', () => {
  test('remembers a message the bot sent', () => {
    noteBotMessageSent('whatsapp', 'msg-1');
    expect(isRecentBotMessage('whatsapp', 'msg-1')).toBe(true);
  });

  test('does not attribute the same id on another platform', () => {
    noteBotMessageSent('whatsapp', 'msg-1');
    expect(isRecentBotMessage('discord', 'msg-1')).toBe(false);
  });

  test('does not attribute an unknown or empty id', () => {
    expect(isRecentBotMessage('whatsapp', 'never-sent')).toBe(false);
    expect(isRecentBotMessage('whatsapp', '')).toBe(false);
    expect(isRecentBotMessage('whatsapp', null)).toBe(false);
    expect(isRecentBotMessage('whatsapp', undefined)).toBe(false);
  });

  test('evicts oldest entries so the index stays bounded', () => {
    for (let i = 0; i < 700; i += 1) noteBotMessageSent('whatsapp', `msg-${i}`);
    // The default cap is 500, so the most recent survive and the oldest do not.
    expect(recentSendIndexSize()).toBeLessThanOrEqual(500);
    expect(isRecentBotMessage('whatsapp', 'msg-699')).toBe(true);
    expect(isRecentBotMessage('whatsapp', 'msg-0')).toBe(false);
  });
});

describe('recordReactionFeedback', () => {
  test('records a positive reaction on a bot message', () => {
    noteBotMessageSent('whatsapp', 'msg-1');
    const before = baselineMetrics();
    const outcome = recordReactionFeedback({
      platform: 'whatsapp', chatRoomId: 'room@g.us', messageId: 'msg-1',
      reaction: '\u{1F44D}', config,
    });
    expect(outcome.recorded).toBe(true);
    const after = baselineMetrics();
    expect(after.positive).toBe(before.positive + 1);
  });

  test('records a negative reaction on a bot message', () => {
    noteBotMessageSent('discord', 'msg-2');
    const before = baselineMetrics();
    recordReactionFeedback({
      platform: 'discord', chatRoomId: '123', messageId: 'msg-2',
      reaction: '\u{1F44E}', config,
    });
    expect(baselineMetrics().negative).toBe(before.negative + 1);
  });

  test('refuses a reaction the bot did not receive', () => {
    // The critical negative case: someone else's message.
    const before = baselineMetrics();
    const outcome = recordReactionFeedback({
      platform: 'whatsapp', chatRoomId: 'room@g.us', messageId: 'someone-elses',
      reaction: '\u{1F44D}', config,
    });
    expect(outcome.recorded).toBe(false);
    if (!outcome.recorded) expect(outcome.reason).toContain('recent bot message');
    expect(baselineMetrics()).toEqual(before);
  });

  test('refuses an ambiguous reaction even on a bot message', () => {
    noteBotMessageSent('whatsapp', 'msg-1');
    const outcome = recordReactionFeedback({
      platform: 'whatsapp', chatRoomId: 'r', messageId: 'msg-1',
      reaction: '\u{1F525}', config,
    });
    expect(outcome.recorded).toBe(false);
    if (!outcome.recorded) expect(outcome.reason).toContain('verdict');
  });

  test('retracting a reaction withdraws it rather than flipping it', () => {
    // A 👎 the user took back must stop counting as a complaint, and must
    // certainly not become praise.
    noteBotMessageSent('whatsapp', 'msg-1');
    const start = baselineMetrics();
    recordReactionFeedback({
      platform: 'whatsapp', chatRoomId: 'r', messageId: 'msg-1',
      reaction: '\u{1F44D}', config,
    });
    expect(baselineMetrics().positive).toBe(start.positive + 1);

    recordReactionFeedback({
      platform: 'whatsapp', chatRoomId: 'r', messageId: 'msg-1',
      reaction: '\u{1F44D}', config, removed: true,
    });
    const after = baselineMetrics();
    // Positive is withdrawn back down; the retraction is never counted.
    expect(after.positive).toBe(start.positive);
    expect(healthMetrics.getMetrics().feedback.retracted).toBeGreaterThan(0);
  });

  test('retraction never drives a counter negative', () => {
    const baseline = healthMetrics.getMetrics().feedback;
    recordReactionFeedback({
      platform: 'whatsapp', chatRoomId: 'r', messageId: 'unknown',
      reaction: '\u{1F44D}', config, removed: true,
    });
    const after = healthMetrics.getMetrics().feedback;
    expect(after.positive).toBe(baseline.positive);
    expect(after.negative).toBe(baseline.negative);
  });

  test('writes a JSONL eval log entry', () => {
    noteBotMessageSent('whatsapp', 'msg-1');
    recordReactionFeedback({
      platform: 'whatsapp', chatRoomId: 'room@g.us', messageId: 'msg-1',
      reaction: '\u{1F44D}', config,
    });
    expect(existsSync(LOG_PATH)).toBe(true);
    const lines = readFileSync(LOG_PATH, 'utf8').trim().split('\n');
    const event = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(event.sentiment).toBe('positive');
    expect(event.messageId).toBe('msg-1');
    expect(event.platform).toBe('whatsapp');
    expect(typeof event.at).toBe('string');
  });

  test('writes nothing when logging is disabled', () => {
    noteBotMessageSent('whatsapp', 'msg-1');
    const outcome = recordReactionFeedback({
      platform: 'whatsapp', chatRoomId: 'r', messageId: 'msg-1',
      reaction: '\u{1F44D}', config: { ...config, enabled: false },
    });
    expect(outcome.recorded).toBe(false);
    expect(existsSync(LOG_PATH)).toBe(false);
  });

  test('enforces the daily volume ceiling', () => {
    noteBotMessageSent('whatsapp', 'msg-1');
    const tiny = { ...config, maxSentimentPerDay: 1 };
    expect(recordReactionFeedback({
      platform: 'whatsapp', chatRoomId: 'r', messageId: 'msg-1', reaction: '\u{1F44D}', config: tiny,
    }).recorded).toBe(true);
    const second = recordReactionFeedback({
      platform: 'whatsapp', chatRoomId: 'r', messageId: 'msg-1', reaction: '\u{1F44D}', config: tiny,
    });
    expect(second.recorded).toBe(false);
    if (!second.recorded) expect(second.reason).toContain('limit');
  });
});

describe('prometheus exposure', () => {
  test('exports the feedback counters', () => {
    noteBotMessageSent('whatsapp', 'msg-1');
    recordReactionFeedback({
      platform: 'whatsapp', chatRoomId: 'r', messageId: 'msg-1', reaction: '\u{1F44D}', config,
    });
    const text = healthMetrics.getPrometheusMetrics();
    expect(text).toContain('elastrax_feedback_total{sentiment="positive"}');
    expect(text).toContain('elastrax_feedback_total{sentiment="negative"}');
    expect(text).toContain('elastrax_feedback_retracted_total');
  });
});
