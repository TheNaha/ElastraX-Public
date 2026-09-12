/**
 * @file src/config/llm.ts
 * @description Shared LLM provider configuration resolution.
 *
 * Extracted from ModelRouter.ts and HealthMonitor.ts to eliminate duplicated
 * env-var parsing and Cloudflare base URL construction. Both modules now use
 * this single source of truth for resolving provider configs from environment
 * variables.
 *
 * Usage:
 *   import { resolveLLMProviders, buildCloudflareBaseUrl } from '../config/llm';
 */

import type { RuntimeEnv } from './runtime';
import type { ModelTier } from '../types/ai';

export interface LLMTarget {
  /** Unique key like 'llm' (legacy) or 'llm:modal' (multi-provider) */
  key: string;
  /** Resolved base URL (may be Cloudflare auto-derived) */
  baseUrl: string;
  /** API key or Bearer token */
  apiKey: string;
  /** Model name */
  modelName: string;
  /** Provider tier for routing */
  tier: ModelTier;
  /** Whether model supports video_url content blocks */
  supportsVideo: boolean;
  /** Whether model supports audio_url content blocks */
  supportsAudio: boolean;
  /** Original provider name (for logging) */
  name: string;
}

/** Provider name prefixes that support video and audio by default (vLLM multimodal deployments). */
const MULTIMODAL_PREFIXES = ['modal'];

/** Well-known provider model defaults. */
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  default: 'meta-llama/Meta-Llama-3-8B-Instruct',
  gemini: 'gemini-2.0-flash',
  openrouter: 'google/gemini-2.0-flash-001',
  groq: 'gpt-4o-mini',
  cloudflare: 'gpt-4o-mini',
  pollinations: 'gpt-4o-mini',
  airforce: 'gpt-4o-mini',
};

/**
 * Build the Cloudflare AI base URL from an account ID.
 * Returns empty string if no account ID is provided.
 */
export function buildCloudflareBaseUrl(accountId?: string): string {
  const trimmed = (accountId || '').trim();
  if (!trimmed) return '';
  return `https://api.cloudflare.com/client/v4/accounts/${trimmed}/ai/v1`;
}

function defaultMediaSupport(name: string): { supportsVideo: boolean; supportsAudio: boolean } {
  const n = name.toLowerCase();
  const isMultimodal = MULTIMODAL_PREFIXES.some(prefix => n.startsWith(prefix));
  return { supportsVideo: isMultimodal, supportsAudio: isMultimodal };
}

function parseTier(raw?: string): ModelTier {
  if (raw === 'fast' || raw === 'powerful') return raw;
  return 'standard';
}

function parseBool(raw: string | undefined, defaultVal: boolean): boolean {
  if (raw === undefined) return defaultVal;
  return raw.trim().toLowerCase() === 'true';
}

function readStringEnv(rawValue: string | undefined, fallback: string = ''): string {
  const trimmed = (rawValue ?? '').trim();
  return trimmed || fallback;
}

/**
 * Resolve all configured LLM providers from environment variables.
 *
 * Supports both:
 * - **Legacy single-provider**: `AI_API_BASE_URL`, `AI_API_KEY`, `AI_MODEL_NAME`
 * - **Multi-provider**: `AI_PROVIDERS=modal,gemini` with per-provider env vars
 *   (`AI_{NAME}_BASE_URL`, `AI_{NAME}_API_KEY`, `AI_{NAME}_MODEL`, etc.)
 *
 * @param env Environment variables (defaults to `process.env`)
 * @returns Array of resolved provider configs, in priority order
 */
export function resolveLLMProviders(env: RuntimeEnv = process.env): LLMTarget[] {
  const providerList = env.AI_PROVIDERS;

  // Legacy single-provider fallback
  if (!providerList || providerList.trim() === '') {
    const legacyCfBase = buildCloudflareBaseUrl(env.AI_CF_ACCOUNT_ID);
    const defaults = defaultMediaSupport('default');
    const baseUrl = readStringEnv(env.AI_API_BASE_URL, legacyCfBase);
    if (!baseUrl) return [];

    return [{
      key: 'llm',
      name: 'default',
      baseUrl,
      apiKey: env.AI_API_KEY || env.AI_CF_API_TOKEN || '',
      modelName: readStringEnv(env.AI_MODEL_NAME, PROVIDER_DEFAULT_MODELS.default),
      tier: parseTier(env.AI_TIER),
      supportsVideo: parseBool(env.AI_SUPPORTS_VIDEO, defaults.supportsVideo),
      supportsAudio: parseBool(env.AI_SUPPORTS_AUDIO, defaults.supportsAudio),
    }];
  }

  return providerList
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(Boolean)
    .map(name => {
      const upper = name.toUpperCase();
      const cfBase = buildCloudflareBaseUrl(env[`AI_${upper}_CF_ACCOUNT_ID`]);
      const defaults = defaultMediaSupport(name);
      const baseUrl = readStringEnv(env[`AI_${upper}_BASE_URL`], cfBase);
      if (!baseUrl) return null;

      return {
        key: `llm:${name}`,
        name,
        baseUrl,
        apiKey: env[`AI_${upper}_API_KEY`] || env[`AI_${upper}_CF_API_TOKEN`] || '',
        modelName: readStringEnv(env[`AI_${upper}_MODEL`], PROVIDER_DEFAULT_MODELS[name] || 'gpt-4o-mini'),
        tier: parseTier(env[`AI_${upper}_TIER`]),
        supportsVideo: parseBool(env[`AI_${upper}_SUPPORTS_VIDEO`], defaults.supportsVideo),
        supportsAudio: parseBool(env[`AI_${upper}_SUPPORTS_AUDIO`], defaults.supportsAudio),
      };
    })
    .filter((t): t is LLMTarget => t !== null);
}

/**
 * Resolve LLM targets in the lightweight format used by HealthMonitor.
 * (Backwards-compatible wrapper around resolveLLMProviders for consumers
 * that only need key, baseUrl, and apiKey.)
 */
export function resolveLLMTargets(env: RuntimeEnv = process.env): { key: string; baseUrl: string; apiKey: string }[] {
  return resolveLLMProviders(env).map(t => ({ key: t.key, baseUrl: t.baseUrl, apiKey: t.apiKey }));
}
