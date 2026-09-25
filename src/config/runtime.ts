/**
 * @file src/config/runtime.ts
 * @description Shared runtime environment parsing helpers and resolved defaults.
 */

export type RuntimeEnv = Record<string, string | undefined>;

export function readIntegerEnv(
  rawValue: string | undefined,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const raw = (rawValue ?? '').trim();
  if (!/^[+-]?\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return fallback;
  if (options.min !== undefined && parsed < options.min) return fallback;
  if (options.max !== undefined && parsed > options.max) return fallback;
  return parsed;
}

export function readFloatEnv(
  rawValue: string | undefined,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const parsed = Number.parseFloat((rawValue ?? '').trim());
  if (!Number.isFinite(parsed)) return fallback;
  if (options.min !== undefined && parsed < options.min) return fallback;
  if (options.max !== undefined && parsed > options.max) return fallback;
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

export function getAIRequestConfig(env: RuntimeEnv = process.env, streaming: boolean = false) {
  return {
    maxTokens: readIntegerEnv(env.AI_MAX_TOKENS, 2048, { min: 1 }),
    timeoutMs: readIntegerEnv(env.AI_TIMEOUT_MS, streaming ? 120000 : 60000, { min: 1 }),
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

export function getWebhookMaxTextLength(env: RuntimeEnv = process.env): number {
  return readIntegerEnv(env.WEBHOOK_MAX_TEXT_LENGTH, 3500, { min: 200, max: 20_000 });
}

export function getWebhookMaxBodyBytes(env: RuntimeEnv = process.env): number {
  return readIntegerEnv(env.WEBHOOK_MAX_BODY_BYTES, 256 * 1024, { min: 1_024, max: 10 * 1024 * 1024 });
}

export function getDownloadMaxMb(env: RuntimeEnv = process.env): number {
  return readIntegerEnv(env.DOWNLOAD_MAX_MB, 50, { min: 1, max: 200 });
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
