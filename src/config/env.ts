import { logger } from '../utils/logger';

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
