import { logger } from '../utils/logger';

type Env = Record<string, string | undefined>;

function parseInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

function validateInteger(
  raw: string | undefined,
  key: string,
  errors: string[],
  options: { min: number; max: number },
): void {
  if (raw === undefined || raw.trim() === '') return;
  const value = parseInteger(raw);
  if (value === null || value < options.min || value > options.max) {
    errors.push(`${key} must be an integer between ${options.min} and ${options.max}`);
  }
}

function validateBoolean(raw: string | undefined, key: string, errors: string[]): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim().toLowerCase();
  if (value !== 'true' && value !== 'false') {
    errors.push(`${key} must be either "true" or "false"`);
    return undefined;
  }
  return value === 'true';
}

function validateFloat(
  raw: string | undefined,
  key: string,
  errors: string[],
  options: { min: number; max: number },
): void {
  if (raw === undefined || raw.trim() === '') return;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < options.min || value > options.max) {
    errors.push(`${key} must be a number between ${options.min} and ${options.max}`);
  }
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value);
}

function validateUrl(
  raw: string | undefined,
  key: string,
  errors: string[],
  options: { required?: boolean; allowLoopbackHttp?: boolean } = {},
): URL | undefined {
  if (raw === undefined || raw.trim() === '') {
    if (options.required) errors.push(`${key} is required`);
    return undefined;
  }
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push(`${key} must use http or https`);
      return undefined;
    }
    if (url.protocol === 'http:' && !options.allowLoopbackHttp && !isLoopbackHost(url.hostname)) {
      errors.push(`${key} must use https unless it points to a loopback address`);
    }
    if (url.username || url.password) {
      errors.push(`${key} must not contain credentials`);
    }
    return url;
  } catch {
    errors.push(`${key} must be a valid URL`);
    return undefined;
  }
}

function validateSecret(raw: string | undefined, key: string, errors: string[], required: boolean): void {
  if (!raw?.trim()) {
    if (required) errors.push(`${key} is required`);
    return;
  }
  if (Buffer.byteLength(raw.trim(), 'utf8') < 24) {
    errors.push(`${key} must contain at least 24 bytes of entropy`);
  }
}

export function validateEnv(env: Env = process.env): void {
  const errors: string[] = [];
  const providerList = env.AI_PROVIDERS?.trim();

  if (!providerList) {
    const model = env.AI_MODEL_NAME?.trim();
    if (!model) errors.push('AI_MODEL_NAME is required in single-provider mode');

    const baseUrl = validateUrl(
      env.AI_API_BASE_URL || (env.AI_CF_ACCOUNT_ID ? `https://api.cloudflare.com/client/v4/accounts/${env.AI_CF_ACCOUNT_ID.trim()}/ai/v1` : ''),
      'AI_API_BASE_URL',
      errors,
      { required: true, allowLoopbackHttp: true },
    );
    const apiKey = env.AI_API_KEY?.trim() || env.AI_CF_API_TOKEN?.trim();
    if (!apiKey && !(baseUrl && isLoopbackHost(baseUrl.hostname))) {
      errors.push('AI_API_KEY is required for non-loopback single-provider endpoints');
    }
  } else {
    const providers = providerList.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    if (providers.length === 0) errors.push('AI_PROVIDERS must contain at least one provider');
    if (new Set(providers).size !== providers.length) errors.push('AI_PROVIDERS must not contain duplicates');

    for (const provider of providers) {
      if (!/^[a-z0-9_-]+$/.test(provider)) {
        errors.push(`AI_PROVIDERS contains an invalid provider name: ${provider}`);
        continue;
      }
      const upper = provider.toUpperCase();
      const baseUrl = validateUrl(
        env[`AI_${upper}_BASE_URL`] || (env[`AI_${upper}_CF_ACCOUNT_ID`] ? `https://api.cloudflare.com/client/v4/accounts/${env[`AI_${upper}_CF_ACCOUNT_ID`]?.trim()}/ai/v1` : ''),
        `AI_${upper}_BASE_URL`,
        errors,
        { required: true, allowLoopbackHttp: true },
      );
      const apiKey = env[`AI_${upper}_API_KEY`]?.trim() || env[`AI_${upper}_CF_API_TOKEN`]?.trim();
      if (!apiKey && !(baseUrl && isLoopbackHost(baseUrl.hostname))) {
        errors.push(`AI_${upper}_API_KEY is required for non-loopback providers`);
      }
      if (!env[`AI_${upper}_MODEL`]?.trim()) {
        errors.push(`AI_${upper}_MODEL is required in multi-provider mode`);
      }
      const tier = env[`AI_${upper}_TIER`]?.trim().toLowerCase();
      if (tier && tier !== 'standard' && tier !== 'fast' && tier !== 'powerful') {
        errors.push(`AI_${upper}_TIER must be standard, fast, or powerful`);
      }
      for (const flag of ['SUPPORTS_IMAGE', 'SUPPORTS_VIDEO', 'SUPPORTS_AUDIO', 'SUPPORTS_TOOLS', 'STREAM_USAGE']) {
        validateBoolean(env[`AI_${upper}_${flag}`], `AI_${upper}_${flag}`, errors);
      }
    }
  }
  const defaultTier = env.AI_TIER?.trim().toLowerCase();
  if (defaultTier && defaultTier !== 'standard' && defaultTier !== 'fast' && defaultTier !== 'powerful') {
    errors.push('AI_TIER must be standard, fast, or powerful');
  }

  validateInteger(env.AI_TOOL_TIMEOUT_MS, 'AI_TOOL_TIMEOUT_MS', errors, { min: 1_000, max: 600_000 });
  validateInteger(env.AI_TIMEOUT_MS, 'AI_TIMEOUT_MS', errors, { min: 1_000, max: 600_000 });
  validateInteger(env.AI_MAX_TOKENS, 'AI_MAX_TOKENS', errors, { min: 1, max: 1_000_000 });
  validateInteger(env.AI_MAX_TOOL_ITERATIONS, 'AI_MAX_TOOL_ITERATIONS', errors, { min: 1, max: 20 });
  validateInteger(env.AI_PROVIDER_COOLDOWN_MS, 'AI_PROVIDER_COOLDOWN_MS', errors, { min: 1_000, max: 3_600_000 });
  validateInteger(env.CONTEXT_MESSAGE_LIMIT, 'CONTEXT_MESSAGE_LIMIT', errors, { min: -1, max: 10_000 });
  validateInteger(env.TRANSCRIBE_TIMEOUT_MS, 'TRANSCRIBE_TIMEOUT_MS', errors, { min: 1_000, max: 600_000 });
  validateInteger(env.WEBHOOK_MAX_BODY_BYTES, 'WEBHOOK_MAX_BODY_BYTES', errors, { min: 1_024, max: 10 * 1024 * 1024 });
  validateInteger(env.WEBHOOK_MAX_TEXT_LENGTH, 'WEBHOOK_MAX_TEXT_LENGTH', errors, { min: 200, max: 20_000 });
  validateInteger(env.WEBHOOK_PORT, 'WEBHOOK_PORT', errors, { min: 1, max: 65_535 });
  validateInteger(env.RATE_LIMIT_MESSAGES, 'RATE_LIMIT_MESSAGES', errors, { min: 1, max: 100_000 });
  validateInteger(env.RATE_LIMIT_WINDOW_SEC, 'RATE_LIMIT_WINDOW_SEC', errors, { min: 1, max: 86_400 });
  validateInteger(env.DOWNLOAD_MAX_MB, 'DOWNLOAD_MAX_MB', errors, { min: 1, max: 1_024 });
  validateInteger(env.MEDIA_CLEANUP_INTERVAL_MS, 'MEDIA_CLEANUP_INTERVAL_MS', errors, { min: 60_000, max: 86_400_000 });
  validateInteger(env.MEDIA_RETENTION_HOURS, 'MEDIA_RETENTION_HOURS', errors, { min: 1, max: 8_760 });
  validateFloat(env.AI_TEMPERATURE, 'AI_TEMPERATURE', errors, { min: 0, max: 2 });

  for (const key of [
    'WEBHOOK_ENABLED',
    'AUTO_REPLY_ALL',
    'CONTEXT_SUMMARIZE',
    'AI_STREAMING',
  ]) {
    validateBoolean(env[key], key, errors);
  }

  validateUrl(env.TRANSCRIBE_ENDPOINT, 'TRANSCRIBE_ENDPOINT', errors, { allowLoopbackHttp: true });
  validateUrl(env.SEARXNG_URL, 'SEARXNG_URL', errors, { allowLoopbackHttp: true });
  validateUrl(env.SEERR_API_URL, 'SEERR_API_URL', errors, { allowLoopbackHttp: true });
  validateUrl(env.JELLYFIN_API_URL, 'JELLYFIN_API_URL', errors, { allowLoopbackHttp: true });
  validateUrl(env.JELLYFIN_EXTERNAL_URL, 'JELLYFIN_EXTERNAL_URL', errors);

  validateSecret(env.WEBHOOK_SECRET, 'WEBHOOK_SECRET', errors, false);
  validateSecret(env.SEERR_WEBHOOK_SECRET, 'SEERR_WEBHOOK_SECRET', errors, false);
  validateSecret(env.JELLYFIN_WEBHOOK_SECRET, 'JELLYFIN_WEBHOOK_SECRET', errors, false);

  if (errors.length > 0) {
    for (const error of errors) logger.error(error);
    throw new Error(`Environment validation failed with ${errors.length} error(s)`);
  }
}
