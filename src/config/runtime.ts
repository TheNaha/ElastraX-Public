/**
 * @file src/config/runtime.ts
 * @description Shared runtime environment parsing helpers and resolved defaults.
 */

import { logger } from '../utils/logger';

export type RuntimeEnv = Record<string, string | undefined>;

/**
 * Minimum length, in bytes, for a shared operator secret.
 *
 * `METRICS_AUTH_TOKEN` is read by two modules that used to disagree about the
 * limit: the admin dashboard accepted 16 characters while the webhook
 * configuration demanded 24 and *threw*. A 16–23 character token therefore
 * passed the admin check and then killed the whole process at startup, and
 * the shipped documentation quoted three different numbers.
 *
 * One constant, one rule: a shared secret must be at least this long, and a
 * token that is too short disables the surfaces it guards instead of taking
 * the bot down.
 */
export const MIN_SHARED_SECRET_BYTES = 24;

/**
 * Whether a shared secret is long enough to be accepted.
 *
 * `Buffer.byteLength` is used rather than `.length` so a multi-byte secret is
 * measured the same way the webhook configuration measured it.
 */
export function isUsableSharedSecret(secret: string | null | undefined): boolean {
  if (!secret) return false;
  return Buffer.byteLength(secret, 'utf8') >= MIN_SHARED_SECRET_BYTES;
}

export function readIntegerEnv(
  rawValue: string | undefined,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const raw = (rawValue ?? '').trim();
  if (!/^[+-]?\d+$/.test(raw)) {
    if (process.env.NODE_ENV !== 'test') {
      logger.warn(`[Config] Invalid integer "${rawValue ?? ''}", using fallback ${fallback}`);
    }
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    if (process.env.NODE_ENV !== 'test') {
      logger.warn(`[Config] Integer "${rawValue}" out of safe range, using fallback ${fallback}`);
    }
    return fallback;
  }
  if (options.min !== undefined && parsed < options.min) {
    if (process.env.NODE_ENV !== 'test') {
      logger.warn(`[Config] Integer "${rawValue}" below minimum ${options.min}, using fallback ${fallback}`);
    }
    return fallback;
  }
  if (options.max !== undefined && parsed > options.max) {
    if (process.env.NODE_ENV !== 'test') {
      logger.warn(`[Config] Integer "${rawValue}" above maximum ${options.max}, using fallback ${fallback}`);
    }
    return fallback;
  }
  return parsed;
}

export function readFloatEnv(
  rawValue: string | undefined,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const parsed = Number.parseFloat((rawValue ?? '').trim());
  if (!Number.isFinite(parsed)) {
    if (process.env.NODE_ENV !== 'test') {
      logger.warn(`[Config] Invalid float "${rawValue ?? ''}", using fallback ${fallback}`);
    }
    return fallback;
  }
  if (options.min !== undefined && parsed < options.min) {
    if (process.env.NODE_ENV !== 'test') {
      logger.warn(`[Config] Float "${rawValue}" below minimum ${options.min}, using fallback ${fallback}`);
    }
    return fallback;
  }
  if (options.max !== undefined && parsed > options.max) {
    if (process.env.NODE_ENV !== 'test') {
      logger.warn(`[Config] Float "${rawValue}" above maximum ${options.max}, using fallback ${fallback}`);
    }
    return fallback;
  }
  return parsed;
}

export function readBooleanEnv(rawValue: string | undefined, fallback: boolean): boolean {
  if (rawValue === undefined) return fallback;
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

export function readStringEnv(rawValue: string | undefined, fallback: string = ''): string {
  const trimmed = (rawValue ?? '').trim();
  return trimmed || fallback;
}

export const MAX_AI_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB guard against runaway LLM responses

export function getAIRequestConfig(env: RuntimeEnv = process.env, streaming: boolean = false) {
  return {
    maxTokens: readIntegerEnv(env.AI_MAX_TOKENS, 2048, { min: 1 }),
    timeoutMs: readIntegerEnv(env.AI_TIMEOUT_MS, streaming ? 120000 : 60000, { min: 1 }),
    maxResponseBytes: readIntegerEnv(env.AI_MAX_RESPONSE_BYTES, MAX_AI_RESPONSE_BYTES, { min: 1 }),
  };
}

export function getToolTimeoutMs(env: RuntimeEnv = process.env): number {
  return readIntegerEnv(env.AI_TOOL_TIMEOUT_MS, 30000, { min: 1 });
}

export function getMaxToolIterations(env: RuntimeEnv = process.env): number {
  return readIntegerEnv(env.AI_MAX_TOOL_ITERATIONS, 8, { min: 1, max: 20 });
}

export function getProviderCooldownMs(env: RuntimeEnv = process.env): number {
  return readIntegerEnv(env.AI_PROVIDER_COOLDOWN_MS, 30000, { min: 1 });
}

export function getStreamingConfig(env: RuntimeEnv = process.env) {
  return {
    enabled: readBooleanEnv(env.AI_STREAMING, false),
    waEditIntervalMs: readIntegerEnv(env.STREAMING_EDIT_INTERVAL_WA, 1500, { min: 100, max: 30_000 }),
    dcEditIntervalMs: readIntegerEnv(env.STREAMING_EDIT_INTERVAL_DC, 500, { min: 100, max: 30_000 }),
  };
}

export function getQueueConfig(env: RuntimeEnv = process.env) {
  return {
    perRoomLimit: readIntegerEnv(env.MESSAGE_QUEUE_PER_ROOM_LIMIT, 50, { min: 1, max: 1_000 }),
    globalLimit: readIntegerEnv(env.MESSAGE_QUEUE_GLOBAL_LIMIT, 500, { min: 1, max: 10_000 }),
    maxAgeMs: readIntegerEnv(env.MESSAGE_QUEUE_MAX_AGE_MS, 5 * 60_000, { min: 10_000, max: 3_600_000 }),
    shutdownGraceMs: readIntegerEnv(env.MESSAGE_QUEUE_SHUTDOWN_GRACE_MS, 15_000, { min: 1_000, max: 120_000 }),
  };
}

export function getTurnBudgetConfig(env: RuntimeEnv = process.env) {
  return {
    maxToolCalls: readIntegerEnv(env.AI_MAX_TOOL_CALLS, 8, { min: 1, max: 32 }),
    maxParallelTools: readIntegerEnv(env.AI_MAX_PARALLEL_TOOLS, 4, { min: 1, max: 16 }),
    maxToolResultBytes: readIntegerEnv(env.AI_MAX_TOOL_RESULT_BYTES, 1024 * 1024, { min: 1_024, max: 10 * 1024 * 1024 }),
    maxToolResultBytesTotal: readIntegerEnv(env.AI_MAX_TOOL_RESULT_BYTES_TOTAL, 4 * 1024 * 1024, { min: 1_024, max: 40 * 1024 * 1024 }),
    maxContextMessages: readIntegerEnv(env.CONTEXT_MESSAGE_LIMIT, 20, { min: -1, max: 10_000 }),
    operationalContextLimit: readIntegerEnv(env.AI_OPERATIONAL_CONTEXT_LIMIT, 1_000, { min: 1, max: 10_000 }),
  };
}

export function getToolLoadingMode(env: RuntimeEnv = process.env): 'all' | 'search' {
  return readStringEnv(env.TOOL_LOADING_MODE, 'search') === 'all' ? 'all' : 'search';
}

export function getTranscriptionConfig(env: RuntimeEnv = process.env) {
  return {
    endpoint: readStringEnv(env.TRANSCRIBE_ENDPOINT),
    apiKey: readStringEnv(env.TRANSCRIBE_API_KEY),
    timeoutMs: readIntegerEnv(env.TRANSCRIBE_TIMEOUT_MS, 45000, { min: 1 }),
  };
}

export function getDownloadMaxMb(env: RuntimeEnv = process.env): number {
  return readIntegerEnv(env.DOWNLOAD_MAX_MB, 50, { min: 1, max: 1_024 });
}

export function getRateLimitConfig(env: RuntimeEnv = process.env) {
  return {
    maxMessages: readIntegerEnv(env.RATE_LIMIT_MESSAGES, 10, { min: 1 }),
    windowSec: readIntegerEnv(env.RATE_LIMIT_WINDOW_SEC, 60, { min: 1 }),
  };
}

export function getMediaCleanupIntervalMs(env: RuntimeEnv = process.env): number {
  return readIntegerEnv(env.MEDIA_CLEANUP_INTERVAL_MS, 6 * 60 * 60 * 1000, { min: 60_000 });
}

export function getMediaRetentionHours(env: RuntimeEnv = process.env): number {
  return readIntegerEnv(env.MEDIA_RETENTION_HOURS, 72, { min: 1 });
}
