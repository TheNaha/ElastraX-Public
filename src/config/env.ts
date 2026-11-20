import { logger } from '../utils/logger';
import { isLoopbackHost as isLoopbackHostShared, isPrivateHost } from '../utils/netAddress';

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
  return isLoopbackHostShared(hostname);
}

function validateUrl(
  raw: string | undefined,
  key: string,
  errors: string[],
  options: { required?: boolean; allowPlainHttp?: boolean; warnings?: string[] } = {},
): URL | undefined {
  if (raw === undefined || raw.trim() === '') {
    if (options.required) errors.push(`${key} is required`);
    return undefined;
  }
  // Only the parse is guarded: a catch around the whole block turned any bug in
  // the validation itself into "must be a valid URL" (that is how a missing
  // import hid here once).
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    errors.push(`${key} must be a valid URL`);
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    errors.push(`${key} must use http or https`);
    return undefined;
  }
  // Loopback http is always allowed. A literal private-network address is
  // allowed too (RFC 1918, IPv6 ULA/link-local, CGNAT 100.64/10): that is what
  // a self-hosted inference box on the LAN looks like, and it cannot be reached
  // from the internet by accident. `allowPlainHttp` stays the wider opt-in for
  // everything else — public addresses, and names, which can resolve anywhere —
  // so a typo like `http://api.openai.com/v1` is still rejected instead of
  // sending the key in cleartext. A private literal over http is accepted but
  // named in a startup warning, because its credentials do travel in cleartext
  // on that network.
  if (url.protocol === 'http:' && !options.allowPlainHttp) {
    if (isPrivateHost(url.hostname) && !isLoopbackHost(url.hostname)) {
      options.warnings?.push(`${key} uses plain http to a private address; its credentials are sent in cleartext on that network`);
    } else if (!isLoopbackHost(url.hostname)) {
      errors.push(
        `${key} must use https unless it points to a loopback or private-network address `
        + '(set ALLOW_INSECURE_HTTP_ENDPOINTS=true to allow any plain-http host)',
      );
    }
  }
  if (url.username || url.password) {
    errors.push(`${key} must not contain credentials`);
  }
  return url;
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
  // Credential-bearing endpoints (AI base URLs, transcription) require https
  // unless they point at loopback. A self-hosted inference server on a private
  // network (`http://100.150.0.4:8080/v1`) has no certificate and is not
  // reachable from the internet, so an operator can opt out explicitly. It has
  // to be opt-in: the API key travels in cleartext, and nothing can tell a
  // private address from a public one at validation time reliably enough to
  // relax this automatically. A *literal* private address (RFC 1918, ULA,
  // CGNAT) is classified exactly and is accepted without the opt-in, with a
  // warning; see `isPrivateHost`.
  const allowInsecureHttp = validateBoolean(
    env.ALLOW_INSECURE_HTTP_ENDPOINTS,
    'ALLOW_INSECURE_HTTP_ENDPOINTS',
    errors,
  ) === true;
  const plainHttpWarnings: string[] = [];

  if (!providerList) {
    const model = env.AI_MODEL_NAME?.trim();
    if (!model) errors.push('AI_MODEL_NAME is required in single-provider mode');

    const baseUrl = validateUrl(
      env.AI_API_BASE_URL || (env.AI_CF_ACCOUNT_ID ? `https://api.cloudflare.com/client/v4/accounts/${env.AI_CF_ACCOUNT_ID.trim()}/ai/v1` : ''),
      'AI_API_BASE_URL',
      errors,
      { required: true, allowPlainHttp: allowInsecureHttp, warnings: plainHttpWarnings },
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
        { required: true, allowPlainHttp: allowInsecureHttp, warnings: plainHttpWarnings },
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
      for (const flag of ['SUPPORTS_IMAGE', 'SUPPORTS_VIDEO', 'SUPPORTS_AUDIO', 'SUPPORTS_TOOLS', 'SUPPORTS_PARALLEL_TOOLS', 'STREAM_USAGE']) {
        validateBoolean(env[`AI_${upper}_${flag}`], `AI_${upper}_${flag}`, errors);
      }
      // ModelRouter reads this per-provider override before the global one, so a
      // bad value must fail startup like its global counterpart.
      const providerTokenParam = env[`AI_${upper}_MAX_TOKENS_PARAM`]?.trim();
      if (providerTokenParam && providerTokenParam !== 'max_tokens' && providerTokenParam !== 'max_completion_tokens') {
        errors.push(`AI_${upper}_MAX_TOKENS_PARAM must be max_tokens or max_completion_tokens`);
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
  // 0 is legal: it binds an ephemeral port, which is what the CI webhook smoke
  // test and any "pick a free port" operator script do. `parseWebhookConfig`
  // already allowed `min: 0`, so this validator was the only thing rejecting a
  // configuration the rest of the system — and the project's own CI — uses.
  validateInteger(env.WEBHOOK_PORT, 'WEBHOOK_PORT', errors, { min: 0, max: 65_535 });
  validateInteger(env.RATE_LIMIT_MESSAGES, 'RATE_LIMIT_MESSAGES', errors, { min: 1, max: 100_000 });
  validateInteger(env.RATE_LIMIT_WINDOW_SEC, 'RATE_LIMIT_WINDOW_SEC', errors, { min: 1, max: 86_400 });
  validateInteger(env.DOWNLOAD_MAX_MB, 'DOWNLOAD_MAX_MB', errors, { min: 1, max: 1_024 });
  validateInteger(env.MEDIA_CLEANUP_INTERVAL_MS, 'MEDIA_CLEANUP_INTERVAL_MS', errors, { min: 60_000, max: 86_400_000 });
  validateInteger(env.MEDIA_RETENTION_HOURS, 'MEDIA_RETENTION_HOURS', errors, { min: 1, max: 8_760 });
  if (env.YTDLP_PATH && !env.YTDLP_PATH.trim()) {
    errors.push('YTDLP_PATH must not be empty');
  }

  validateInteger(env.TOOL_MUTATION_COST_LIMIT, 'TOOL_MUTATION_COST_LIMIT', errors, { min: 1, max: 1000 });

  const syncMode = env.ELASTRAX_DB_SYNCHRONOUS?.trim().toUpperCase();
  if (syncMode && syncMode !== 'OFF' && syncMode !== 'NORMAL' && syncMode !== 'FULL') {
    errors.push('ELASTRAX_DB_SYNCHRONOUS must be OFF, NORMAL, or FULL');
  }

  validateFloat(env.AI_TEMPERATURE, 'AI_TEMPERATURE', errors, { min: 0, max: 2 });

  for (const key of [
    'WEBHOOK_ENABLED',
    'AUTO_REPLY_ALL',
    'ALLOW_TOOLS',
    'CONTEXT_SUMMARIZE',
    'LONG_TERM_MEMORY',
    'AI_STREAMING',
    'AI_VERBOSE_LOGS',
  ]) {
    validateBoolean(env[key], key, errors);
  }

  // Capability flags are read in `ModelRouter.loadProviders()` through
  // `envBoolean`, which *throws* on anything other than true/false. In
  // single-provider mode that throw surfaced on the first chat call, so a typo
  // like `AI_SUPPORTS_IMAGE=yes` broke every message instead of failing startup
  // once with the aggregated error. `AI_SUPPORTS_VIDEO`/`AUDIO` are accepted for
  // symmetry with the per-provider forms.
  for (const key of [
    'AI_SUPPORTS_IMAGE',
    'AI_SUPPORTS_VIDEO',
    'AI_SUPPORTS_AUDIO',
    'AI_SUPPORTS_TOOLS',
    'AI_SUPPORTS_PARALLEL_TOOLS',
    'AI_STREAM_USAGE',
  ]) {
    validateBoolean(env[key], key, errors);
  }
  const maxTokensParam = env.AI_MAX_TOKENS_PARAM?.trim();
  if (maxTokensParam && maxTokensParam !== 'max_tokens' && maxTokensParam !== 'max_completion_tokens') {
    errors.push('AI_MAX_TOKENS_PARAM must be max_tokens or max_completion_tokens');
  }

  validateUrl(env.TRANSCRIBE_ENDPOINT, 'TRANSCRIBE_ENDPOINT', errors, { allowPlainHttp: allowInsecureHttp, warnings: plainHttpWarnings });
  validateUrl(env.SEARXNG_URL, 'SEARXNG_URL', errors, { allowPlainHttp: true });
  validateUrl(env.SEERR_API_URL, 'SEERR_API_URL', errors, { allowPlainHttp: true });
  validateUrl(env.JELLYFIN_API_URL, 'JELLYFIN_API_URL', errors, { allowPlainHttp: true });
  validateUrl(env.JELLYFIN_EXTERNAL_URL, 'JELLYFIN_EXTERNAL_URL', errors);

  validateSecret(env.WEBHOOK_SECRET, 'WEBHOOK_SECRET', errors, false);
  validateSecret(env.SEERR_WEBHOOK_SECRET, 'SEERR_WEBHOOK_SECRET', errors, false);
  validateSecret(env.JELLYFIN_WEBHOOK_SECRET, 'JELLYFIN_WEBHOOK_SECRET', errors, false);
  // METRICS_AUTH_TOKEN is deliberately not length-checked here: a short token
  // only disables /metrics and /admin (readOptionalSharedSecret fails soft),
  // which is the documented behaviour. Failing startup over a telemetry token
  // contradicted it. WEBHOOK_SECRET and the per-service secrets still hard-fail
  // because intake cannot authenticate without them.

  if (errors.length > 0) {
    for (const error of errors) logger.error(error);
    throw new Error(`Environment validation failed with ${errors.length} error(s)`);
  }

  // An accepted private-network literal over http: no opt-in needed, but the
  // cleartext exposure is still named once per endpoint.
  for (const warning of plainHttpWarnings) logger.warn(warning);

  if (allowInsecureHttp) {
    logger.warn(
      'ALLOW_INSECURE_HTTP_ENDPOINTS is set: plain http:// is accepted for AI provider base URLs and '
      + 'TRANSCRIBE_ENDPOINT, so those API keys are sent in cleartext. Keep those hosts on a trusted private network.',
    );
  }
}
