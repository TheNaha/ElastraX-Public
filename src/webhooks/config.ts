export type WebhookEnv = Record<string, string | undefined>;

export type SecretCompatibilityWindow = {
  enabled: boolean;
  expiresAt: number | null;
};

export type WebhookConfig = {
  enabled: boolean;
  host: string;
  port: number;
  sharedSecret: string | null;
  seerrSecret: string | null;
  jellyfinSecret: string | null;
  metricsToken: string | null;
  bodySecretCompatibility: SecretCompatibilityWindow;
  querySecretCompatibility: SecretCompatibilityWindow;
  maxBodyBytes: number;
  maxTextLength: number;
  maxDestinations: number;
  maxSourceLength: number;
  maxRoomIdLength: number;
  bodyReadTimeoutMs: number;
  enqueueTimeoutMs: number;
  readinessTimeoutMs: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  rateLimitMaxSources: number;
  replayTtlMs: number;
  replayMaxEntries: number;
};

type IntegerOptions = {
  min: number;
  max: number;
};

const DEFAULT_PORT = 3500;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_TEXT_LENGTH = 3500;
const DEFAULT_MAX_DESTINATIONS = 25;
const DEFAULT_MAX_SOURCE_LENGTH = 128;
const DEFAULT_MAX_ROOM_ID_LENGTH = 256;
const DEFAULT_BODY_READ_TIMEOUT_MS = 5000;
const DEFAULT_ENQUEUE_TIMEOUT_MS = 5000;
const DEFAULT_READINESS_TIMEOUT_MS = 2000;
const DEFAULT_RATE_LIMIT_MAX = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX_SOURCES = 10_000;
const DEFAULT_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REPLAY_MAX_ENTRIES = 10_000;
const MIN_SECRET_BYTES = 24;
const ABSOLUTE_RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;

function parseAbsoluteRfc3339(value: string): number | null {
  const match = ABSOLUTE_RFC3339.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[9] ?? 0);
  const offsetMinute = Number(match[10] ?? 0);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59
  ) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readInteger(
  env: WebhookEnv,
  key: string,
  fallback: number,
  options: IntegerOptions,
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${key} must be a base-10 integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < options.min || value > options.max) {
    throw new Error(`${key} must be between ${options.min} and ${options.max}`);
  }
  return value;
}

function readBoolean(env: WebhookEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`${key} must be exactly "true" or "false"`);
  }
  return raw === 'true';
}

function readSecret(env: WebhookEnv, key: string): string | null {
  const raw = env[key];
  if (raw === undefined || raw === '') return null;
  if (raw !== raw.trim()) {
    throw new Error(`${key} must not have leading or trailing whitespace`);
  }
  if (Buffer.byteLength(raw, 'utf8') < MIN_SECRET_BYTES) {
    throw new Error(`${key} must contain at least ${MIN_SECRET_BYTES} bytes`);
  }
  return raw;
}

function readCompatibilityWindow(
  env: WebhookEnv,
  prefix: 'WEBHOOK_BODY' | 'WEBHOOK_QUERY',
  now: number,
): SecretCompatibilityWindow {
  const enabledKey = `${prefix}_SECRET_COMPAT_ENABLED`;
  const untilKey = `${prefix}_SECRET_COMPAT_UNTIL`;
  const enabled = readBoolean(env, enabledKey, false);
  const rawUntil = env[untilKey];
  const expiresAt = rawUntil === undefined ? null : parseAbsoluteRfc3339(rawUntil);
  if (rawUntil !== undefined && expiresAt === null) {
    throw new Error(`${untilKey} must be an absolute RFC3339 timestamp with a timezone`);
  }

  if (!enabled) {
    return { enabled: false, expiresAt };
  }

  if (expiresAt === null) {
    throw new Error(`${untilKey} is required when ${enabledKey} is true`);
  }
  if (expiresAt <= now) {
    throw new Error(`${untilKey} must be in the future`);
  }
  return { enabled: true, expiresAt };
}

function readHost(env: WebhookEnv): string {
  const host = env.WEBHOOK_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host)) {
    throw new Error('WEBHOOK_HOST must be 127.0.0.1, ::1, or 0.0.0.0');
  }
  if (host === '0.0.0.0' && env.WEBHOOK_CONTAINER_MODE !== 'true') {
    throw new Error('WEBHOOK_HOST=0.0.0.0 requires WEBHOOK_CONTAINER_MODE=true');
  }
  return host;
}

export function parseWebhookConfig(
  env: WebhookEnv = process.env,
  now: number = Date.now(),
): WebhookConfig {
  return {
    enabled: readBoolean(env, 'WEBHOOK_ENABLED', true),
    host: readHost(env),
    port: readInteger(env, 'WEBHOOK_PORT', DEFAULT_PORT, { min: 0, max: 65_535 }),
    sharedSecret: readSecret(env, 'WEBHOOK_SECRET'),
    seerrSecret: readSecret(env, 'SEERR_WEBHOOK_SECRET'),
    jellyfinSecret: readSecret(env, 'JELLYFIN_WEBHOOK_SECRET'),
    metricsToken: readSecret(env, 'METRICS_AUTH_TOKEN'),
    bodySecretCompatibility: readCompatibilityWindow(env, 'WEBHOOK_BODY', now),
    querySecretCompatibility: readCompatibilityWindow(env, 'WEBHOOK_QUERY', now),
    maxBodyBytes: readInteger(env, 'WEBHOOK_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES, {
      min: 1024,
      max: 10 * 1024 * 1024,
    }),
    maxTextLength: readInteger(env, 'WEBHOOK_MAX_TEXT_LENGTH', DEFAULT_MAX_TEXT_LENGTH, {
      min: 200,
      max: 20_000,
    }),
    maxDestinations: readInteger(env, 'WEBHOOK_MAX_DESTINATIONS', DEFAULT_MAX_DESTINATIONS, {
      min: 1,
      max: 100,
    }),
    maxSourceLength: readInteger(env, 'WEBHOOK_MAX_SOURCE_LENGTH', DEFAULT_MAX_SOURCE_LENGTH, {
      min: 8,
      max: 1024,
    }),
    maxRoomIdLength: readInteger(env, 'WEBHOOK_MAX_ROOM_ID_LENGTH', DEFAULT_MAX_ROOM_ID_LENGTH, {
      min: 16,
      max: 512,
    }),
    bodyReadTimeoutMs: readInteger(env, 'WEBHOOK_BODY_READ_TIMEOUT_MS', DEFAULT_BODY_READ_TIMEOUT_MS, {
      min: 100,
      max: 30_000,
    }),
    enqueueTimeoutMs: readInteger(env, 'WEBHOOK_ENQUEUE_TIMEOUT_MS', DEFAULT_ENQUEUE_TIMEOUT_MS, {
      min: 100,
      max: 30_000,
    }),
    readinessTimeoutMs: readInteger(env, 'WEBHOOK_READINESS_TIMEOUT_MS', DEFAULT_READINESS_TIMEOUT_MS, {
      min: 100,
      max: 10_000,
    }),
    rateLimitMax: readInteger(env, 'WEBHOOK_RATE_LIMIT_MAX', DEFAULT_RATE_LIMIT_MAX, {
      min: 1,
      max: 10_000,
    }),
    rateLimitWindowMs: readInteger(env, 'WEBHOOK_RATE_LIMIT_WINDOW_MS', DEFAULT_RATE_LIMIT_WINDOW_MS, {
      min: 1000,
      max: 60 * 60 * 1000,
    }),
    rateLimitMaxSources: readInteger(env, 'WEBHOOK_RATE_LIMIT_MAX_SOURCES', DEFAULT_RATE_LIMIT_MAX_SOURCES, {
      min: 100,
      max: 100_000,
    }),
    replayTtlMs: readInteger(env, 'WEBHOOK_REPLAY_TTL_MS', DEFAULT_REPLAY_TTL_MS, {
      min: 1000,
      max: 7 * 24 * 60 * 60 * 1000,
    }),
    replayMaxEntries: readInteger(env, 'WEBHOOK_REPLAY_MAX_ENTRIES', DEFAULT_REPLAY_MAX_ENTRIES, {
      min: 100,
      max: 100_000,
    }),
  };
}
