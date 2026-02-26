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

/**
 * Validates that all required environment variables are present and well-formed.
 *
 * @param env - Environment object to validate (defaults to `process.env`). Injected for
 *              testability so unit tests can pass a fake env without touching the process.
 * @throws    {Error} if one or more required variables are missing or invalid.
 */
export function validateEnv(env: Record<string, string | undefined> = process.env): void {
  const errors: string[] = [];
  const requiredVars = ['AI_API_KEY', 'AI_MODEL_NAME', 'AI_API_BASE_URL'];

  for (const key of requiredVars) {
    const val = env[key];
    if (!val || val.trim() === '') {
      errors.push(`${key} is missing or empty`);
    }
  }

  // Specific validation for AI_API_BASE_URL - check only if present (to avoid double error)
  const baseUrl = env.AI_API_BASE_URL;
  if (baseUrl && baseUrl.trim() !== '') {
    try {
      new URL(baseUrl);
    } catch {
      errors.push(`AI_API_BASE_URL is not a valid URL: "${baseUrl}"`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      logger.error(error);
    }
    throw new Error(`Environment validation failed with ${errors.length} error(s). See logs for details.`);
  }
}
