/**
 * @file src/config/env.ts
 * @description Startup environment validation for ElastraX.
 *
 * `validateEnv()` is called once at the very beginning of `main()` in `src/index.ts`.
 * It checks that all required environment variables are present and well-formed before
 * any providers or database connections are initialised.  If validation fails the
 * function throws, causing the process to exit with an error log — preventing a
 * partially-started bot that silently cannot talk to the LLM.
 *
 * Required variables:
 *   - AI_API_KEY       — Bearer token for the LLM provider.
 *   - AI_MODEL_NAME    — Full model identifier (e.g., "meta-llama/Meta-Llama-3-8B-Instruct").
 *   - AI_API_BASE_URL  — OpenAI-compatible base URL (must be a valid URL).
 */

import { logger } from '../utils/logger';

function validatePositiveInteger(rawValue: string | undefined, envKey: string, errors: string[]): void {
  if (rawValue === undefined || rawValue.trim() === '') return;
  const parsed = Number.parseInt(rawValue.trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    errors.push(`${envKey} must be a positive integer when set`);
  }
}

function validateBoolean(rawValue: string | undefined, envKey: string, errors: string[]): void {
  if (rawValue === undefined || rawValue.trim() === '') return;
  const normalized = rawValue.trim().toLowerCase();
  if (normalized !== 'true' && normalized !== 'false') {
    errors.push(`${envKey} must be either "true" or "false" when set`);
  }
}

function validateNumberInRange(
  rawValue: string | undefined,
  envKey: string,
  min: number,
  max: number,
  errors: string[],
): void {
  if (rawValue === undefined || rawValue.trim() === '') return;
  const parsed = Number.parseFloat(rawValue.trim());
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    errors.push(`${envKey} must be a number between ${min} and ${max} when set`);
  }
}

function validateUrl(rawValue: string | undefined, envKey: string, errors: string[]): void {
  if (!rawValue || rawValue.trim() === '') return;
  try {
    new URL(rawValue);
  } catch {
    errors.push(`${envKey} is not a valid URL: "${rawValue}"`);
  }
}

function validatePort(rawValue: string | undefined, envKey: string, errors: string[]): void {
  if (rawValue === undefined || rawValue.trim() === '') return;
  const parsed = Number.parseInt(rawValue.trim(), 10);
  const isValid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535;
  if (!isValid) {
    errors.push(`${envKey} must be an integer between 0 and 65535 when set`);
  }
}

/**
 * Validates that all required environment variables are present and well-formed.
 *
 * @param env - Environment object to validate (defaults to `process.env`). Injected for
 *              testability so unit tests can pass a fake env without touching the process.
 * @throws    {Error} if one or more required variables are missing or invalid.
 */
export function validateEnv(env: Record<string, string | undefined> = process.env): void {
  const errors: string[] = [];
  const providerList = env.AI_PROVIDERS?.trim();

  const buildCloudflareBaseUrl = (accountId?: string) => {
    const trimmed = (accountId || '').trim();
    if (!trimmed) return '';
    return `https://api.cloudflare.com/client/v4/accounts/${trimmed}/ai/v1`;
  };

  if (!providerList) {
    // Legacy single-provider mode
    const modelName = env.AI_MODEL_NAME;
    if (!modelName || modelName.trim() === '') {
      errors.push('AI_MODEL_NAME is missing or empty');
    }

    const baseUrl = env.AI_API_BASE_URL || buildCloudflareBaseUrl(env.AI_CF_ACCOUNT_ID);
    const apiKey = env.AI_API_KEY || env.AI_CF_API_TOKEN;

    if (!apiKey || apiKey.trim() === '') {
      errors.push('AI_API_KEY is missing or empty');
    }

    if (!baseUrl || baseUrl.trim() === '') {
      errors.push('AI_API_BASE_URL is missing or empty');
    }

    if (baseUrl && baseUrl.trim() !== '') {
      try {
        new URL(baseUrl);
      } catch {
        errors.push(`AI_API_BASE_URL is not a valid URL: "${baseUrl}"`);
      }
    }
  } else {
    // Multi-provider failover mode
    const providers = providerList.split(',').map(p => p.trim().toUpperCase()).filter(Boolean);
    if (providers.length === 0) {
      errors.push('AI_PROVIDERS is set but empty after parsing.');
    }

    for (const provider of providers) {
      const baseKey = `AI_${provider}_BASE_URL`;
      const modelKey = `AI_${provider}_MODEL`;
      const cfAccountKey = `AI_${provider}_CF_ACCOUNT_ID`;
      const apiKey = `AI_${provider}_API_KEY`;
      const cfTokenKey = `AI_${provider}_CF_API_TOKEN`;
      const baseUrl = env[baseKey] || buildCloudflareBaseUrl(env[cfAccountKey]);
      const modelName = env[modelKey];

      if (!baseUrl || baseUrl.trim() === '') {
        errors.push(`${baseKey} is missing or empty (or set ${cfAccountKey} for Cloudflare shorthand)`);
      } else {
        try {
          new URL(baseUrl);
        } catch {
          errors.push(`${baseKey} is not a valid URL: "${baseUrl}"`);
        }
      }

      if (!modelName || modelName.trim() === '') {
        errors.push(`${modelKey} is missing or empty`);
      }

      const keyValue = env[apiKey] || env[cfTokenKey];
      if (!keyValue || keyValue.trim() === '') {
        errors.push(`${apiKey} is missing or empty (or set ${cfTokenKey} for Cloudflare shorthand)`);
      }
    }
  }

  validatePositiveInteger(env.AI_TOOL_TIMEOUT_MS, 'AI_TOOL_TIMEOUT_MS', errors);
  validatePositiveInteger(env.AI_TIMEOUT_MS, 'AI_TIMEOUT_MS', errors);
  validatePositiveInteger(env.AI_MAX_TOKENS, 'AI_MAX_TOKENS', errors);
  validatePositiveInteger(env.AI_MAX_TOOL_ITERATIONS, 'AI_MAX_TOOL_ITERATIONS', errors);
  validatePositiveInteger(env.AI_PROVIDER_COOLDOWN_MS, 'AI_PROVIDER_COOLDOWN_MS', errors);
  validatePositiveInteger(env.CONTEXT_MESSAGE_LIMIT, 'CONTEXT_MESSAGE_LIMIT', errors);
  validatePositiveInteger(env.TRANSCRIBE_TIMEOUT_MS, 'TRANSCRIBE_TIMEOUT_MS', errors);
  validatePositiveInteger(env.WEBHOOK_MAX_BODY_BYTES, 'WEBHOOK_MAX_BODY_BYTES', errors);
  validateNumberInRange(env.AI_TEMPERATURE, 'AI_TEMPERATURE', 0, 2, errors);
  validateBoolean(env.AUTO_REPLY_ALL, 'AUTO_REPLY_ALL', errors);
  validateBoolean(env.CONTEXT_SUMMARIZE, 'CONTEXT_SUMMARIZE', errors);
  validatePort(env.WEBHOOK_PORT, 'WEBHOOK_PORT', errors);
  validateUrl(env.TRANSCRIBE_ENDPOINT, 'TRANSCRIBE_ENDPOINT', errors);

  if (errors.length > 0) {
    for (const error of errors) {
      logger.error(error);
    }
    throw new Error(`Environment validation failed with ${errors.length} error(s). See logs for details.`);
  }
}
