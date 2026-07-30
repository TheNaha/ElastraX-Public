/**
 * @file src/utils/ModelRouter.ts
 * @description Multi-provider LLM router with automatic failover.
 *
 * Tries AI providers in priority order, falling back to the next one if a
 * request fails. This ensures high availability and allows you to mix providers
 * (e.g., Modal for speed, Gemini as backup, local Ollama as last resort).
 *
 * Configuration — set AI_PROVIDERS to a comma-separated priority list:
 *   AI_PROVIDERS=modal,gemini,ollama        (default: just uses the legacy AI_API_BASE_URL setup)
 *
 * Per-provider environment variables (replace {NAME} with the provider name in uppercase):
 *   AI_{NAME}_BASE_URL        — OpenAI-compatible endpoint (required per provider)
 *   AI_{NAME}_API_KEY         — Bearer token (optional, defaults to 'dummy')
 *   AI_{NAME}_MODEL           — Model identifier
 *   AI_{NAME}_SUPPORTS_VIDEO  — 'true' if the model/provider accepts video_url content blocks
 *   AI_{NAME}_SUPPORTS_AUDIO  — 'true' if the model/provider accepts audio_url content blocks
 *
 * Well-known provider auto-defaults (can be overridden via env):
 *   modal      — supportsVideo: true,  supportsAudio: true  (vLLM / Qwen3-Omni)
 *   gemini     — supportsVideo: false, supportsAudio: false (inline base64 not supported via OAI compat)
 *   openrouter — supportsVideo: false, supportsAudio: false
 *   groq       — supportsVideo: false, supportsAudio: false
 *   cloudflare — supportsVideo: false, supportsAudio: false
 *   pollinations— supportsVideo: false, supportsAudio: false
 *   airforce   — supportsVideo: false, supportsAudio: false
 *
 * Example .env block:
 *   AI_PROVIDERS=modal1,pollinations,airforce,cloudflare,openrouter,groq,gemini
 *   AI_MODAL1_BASE_URL=https://your-modal-endpoint.modal.run/v1
 *   AI_MODAL1_API_KEY=dummy
 *   AI_MODAL1_MODEL=cyankiwi/Qwen3-Omni-30B-A3B-Instruct-AWQ-4bit
 *   AI_MODAL1_SUPPORTS_VIDEO=true
 *   AI_MODAL1_SUPPORTS_AUDIO=true
 *
 * If AI_PROVIDERS is not set, it falls back to the legacy single-provider setup
 * (AI_API_BASE_URL / AI_API_KEY / AI_MODEL_NAME).
 */

import { logger } from './logger';
import { AIClient } from '../ai/client';
import type { AIChatMessage, AIContentPart } from '../ai/client';
import type { ToolDefinition } from '../tools/BaseTool';
import type { ChatCompletionMessage, ChatCompletionChunk, ModelTier, TokenUsage } from '../types/ai';
import { healthMetrics } from './HealthMetrics';
import { getErrorMessage } from './errorUtils';
import { getAIRequestConfig, getProviderCooldownMs } from '../config/runtime';

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  /** Model tier for multi-model routing. Defaults to 'standard'. */
  tier: ModelTier;
  /**
   * V7.13: Whether this provider's model accepts `video_url` content blocks.
   * Defaults to false for all providers except modal-style vLLM deployments.
   */
  supportsVideo: boolean;
  /**
   * V7.13: Whether this provider's model accepts `audio_url` content blocks.
   * Defaults to false for all providers except modal-style vLLM deployments.
   */
  supportsAudio: boolean;
}

/** Internal provider with a pre-built, cached AIClient instance. */
interface ResolvedProvider extends ProviderConfig {
  client: AIClient;
}

type MessageWithUsage = ChatCompletionMessage & {
  usage?: Partial<TokenUsage>;
};

/**
 * Provider name prefixes that support video and audio by default (vLLM multimodal deployments).
 * Any provider whose name starts with one of these strings gets supportsVideo/Audio=true
 * unless the env var explicitly overrides it to 'false'.
 */
const MULTIMODAL_PREFIXES = ['modal'];

/** Resolve default video/audio support based on well-known provider names. */
function defaultMediaSupport(name: string): { supportsVideo: boolean; supportsAudio: boolean } {
  const n = name.toLowerCase();
  const isMultimodal = MULTIMODAL_PREFIXES.some(prefix => n.startsWith(prefix));
  return { supportsVideo: isMultimodal, supportsAudio: isMultimodal };
}

function buildCloudflareBaseUrl(accountId?: string): string {
  const trimmed = (accountId || '').trim();
  if (!trimmed) return '';
  return `https://api.cloudflare.com/client/v4/accounts/${trimmed}/ai/v1`;
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, '');
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

function parseTier(raw?: string): ModelTier {
  if (raw === 'fast' || raw === 'powerful') return raw;
  return 'standard';
}

function parseBool(raw: string | undefined, defaultVal: boolean): boolean {
  if (raw === undefined) return defaultVal;
  return raw.toLowerCase() === 'true';
}

/** Loads all provider configs from process.env according to the documented pattern. */
function loadProviders(): ResolvedProvider[] {
  const providerList = process.env.AI_PROVIDERS;

  // Legacy single-provider fallback
  if (!providerList || providerList.trim() === '') {
    const legacyCfBase = buildCloudflareBaseUrl(process.env.AI_CF_ACCOUNT_ID);
    const defaults = defaultMediaSupport('default');
    const cfg: ProviderConfig = {
      name: 'default',
      baseUrl: process.env.AI_API_BASE_URL || legacyCfBase,
      apiKey: process.env.AI_API_KEY || process.env.AI_CF_API_TOKEN || '',
      modelName: process.env.AI_MODEL_NAME || 'meta-llama/Meta-Llama-3-8B-Instruct',
      tier: parseTier(process.env.AI_TIER),
      supportsVideo: parseBool(process.env.AI_SUPPORTS_VIDEO, defaults.supportsVideo),
      supportsAudio: parseBool(process.env.AI_SUPPORTS_AUDIO, defaults.supportsAudio),
    };
    return [{
      ...cfg,
      client: new AIClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, modelName: cfg.modelName }),
    }];
  }

  return providerList.split(',').map(p => p.trim().toLowerCase()).filter(Boolean).map(name => {
    const upper = name.toUpperCase();
    const cfBase = buildCloudflareBaseUrl(process.env[`AI_${upper}_CF_ACCOUNT_ID`]);
    const defaults = defaultMediaSupport(name);
    const cfg: ProviderConfig = {
      name,
      baseUrl: process.env[`AI_${upper}_BASE_URL`] || cfBase,
      apiKey: process.env[`AI_${upper}_API_KEY`] || process.env[`AI_${upper}_CF_API_TOKEN`] || '',
      modelName: process.env[`AI_${upper}_MODEL`] || 'gpt-4o-mini',
      tier: parseTier(process.env[`AI_${upper}_TIER`]),
      supportsVideo: parseBool(process.env[`AI_${upper}_SUPPORTS_VIDEO`], defaults.supportsVideo),
      supportsAudio: parseBool(process.env[`AI_${upper}_SUPPORTS_AUDIO`], defaults.supportsAudio),
    };
    return {
      ...cfg,
      client: new AIClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, modelName: cfg.modelName }),
    };
  });
}

/**
 * V7.13: Sanitize a messages array for a specific provider's capabilities.
 *
 * Strips `video_url` and `audio_url` content block types if the provider doesn't support them,
 * replacing them with a plain-text description so the AI is still aware media was present.
 *
 * Returns a new messages array (does not mutate the original).
 */
export function sanitizeMessagesForProvider(
  messages: AIChatMessage[],
  provider: Pick<ProviderConfig, 'supportsVideo' | 'supportsAudio'>,
): AIChatMessage[] {
  if (provider.supportsVideo && provider.supportsAudio) {
    // Provider supports everything — no transformation needed
    return messages;
  }

  return messages.map(msg => {
    if (!Array.isArray(msg.content)) return msg;

    const sanitized: AIContentPart[] = [];
    for (const part of msg.content) {
      if (part?.type === 'video_url' && !provider.supportsVideo) {
        sanitized.push({ type: 'text', text: '[Video attached — not supported by this provider]' });
      } else if (part?.type === 'audio_url' && !provider.supportsAudio) {
        sanitized.push({ type: 'text', text: '[Audio attached — not supported by this provider]' });
      } else {
        sanitized.push(part);
      }
    }

    return { ...msg, content: sanitized };
  });
}

/**
 * Singleton router that tries providers in priority order with automatic failover.
 * Pre-builds and caches AIClient instances at init time for efficiency.
 * Supports tier-based routing for multi-model strategies.
 */
export class ModelRouter {
  private providers: ResolvedProvider[];
  private providerCooldownUntil = new Map<string, number>();
  private providerFailureCount = new Map<string, number>();
  private static readonly CIRCUIT_BREAKER_THRESHOLD = 5;

  constructor() {
    this.providers = loadProviders();
    if (this.providers.length === 0) {
      throw new Error('No AI providers configured. Set AI_PROVIDERS or AI_API_BASE_URL.');
    }
    logger.info({
      providers: this.providers.map(p => ({ name: p.name, tier: p.tier, supportsVideo: p.supportsVideo, supportsAudio: p.supportsAudio })),
    }, '[ModelRouter] Loaded providers with cached clients');
  }

  /**
   * Returns providers filtered by tier preference.
   * If a tier is specified, providers matching that tier are tried first,
   * then all others as fallback.
   */
  private getProvidersByTier(tier?: ModelTier): ResolvedProvider[] {
    if (!tier) return this.providers;

    // ⚡ Bolt: Use a single pass to partition providers instead of two .filter() calls
    const preferred: ResolvedProvider[] = [];
    const fallback: ResolvedProvider[] = [];
    for (const p of this.providers) {
      if (p.tier === tier) preferred.push(p);
      else fallback.push(p);
    }

    if (preferred.length === 0) {
      logger.debug({ tier }, '[ModelRouter] No providers match requested tier, using all');
      return this.providers;
    }
    // ⚡ Bolt: Use .concat() instead of spread operator [...preferred, ...fallback] for better performance
    return preferred.concat(fallback);
  }

  private getCandidateProviders(tier?: ModelTier): ResolvedProvider[] {
    const orderedProviders = this.getProvidersByTier(tier);
    const now = Date.now();

    const availableProviders: ResolvedProvider[] = [];
    const skippedProviderNames: string[] = [];

    for (const provider of orderedProviders) {
      const cooldownUntil = this.providerCooldownUntil.get(provider.name) ?? 0;
      const failures = this.providerFailureCount.get(provider.name) ?? 0;

      if (cooldownUntil > now) {
        skippedProviderNames.push(failures >= ModelRouter.CIRCUIT_BREAKER_THRESHOLD ? provider.name + '(circuit-breaker)' : provider.name);
        continue;
      }

      if (failures >= ModelRouter.CIRCUIT_BREAKER_THRESHOLD) {
        // Half-open state: cooldown passed, try again with reduced failure count
        this.providerFailureCount.set(provider.name, ModelRouter.CIRCUIT_BREAKER_THRESHOLD - 1);
      }

      availableProviders.push(provider);
    }

    if (availableProviders.length === 0) {
      return orderedProviders;
    }

    if (skippedProviderNames.length > 0) {
      logger.debug({
        skippedProviders: skippedProviderNames,
      }, '[ModelRouter] Skipping providers in cooldown window');
    }

    return availableProviders;
  }

  private clearProviderCooldown(providerName: string): void {
    this.providerCooldownUntil.delete(providerName);
    this.providerFailureCount.delete(providerName);
  }

  private markProviderFailure(providerName: string): void {
    const current = this.providerFailureCount.get(providerName) ?? 0;
    this.providerFailureCount.set(providerName, current + 1);
    this.providerCooldownUntil.set(providerName, Date.now() + getProviderCooldownMs());
  }

  private getUsage(result: ChatCompletionMessage): Partial<TokenUsage> | undefined {
    return (result as MessageWithUsage).usage;
  }

  /**
   * Sends a chat completion request, trying each provider in order until one succeeds.
   *
   * @param messages    Full conversation history including system prompt.
   * @param tools       Optional LLM function-calling tool definitions.
   * @param temperature Sampling temperature.
   * @param maxTokens   Max tokens to generate.
   * @param tier        Optional model tier preference for multi-model routing.
   * @returns           Typed `ChatCompletionMessage` from choices[0].
   * @throws            If ALL providers fail, re-throws the last error.
   */
  async chatCompletion(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7,
    maxTokens?: number,
    tier?: ModelTier,
  ): Promise<ChatCompletionMessage> {
    let lastError: Error | null = null;
    const verbose = process.env.AI_VERBOSE_LOGS === 'true';
    const orderedProviders = this.getCandidateProviders(tier);

    for (const provider of orderedProviders) {
      try {
        if (!provider.baseUrl) throw new Error(`Provider "${provider.name}" has no base URL.`);

        const resolvedMaxTokens = maxTokens ?? getAIRequestConfig().maxTokens;
        // V7.13: Strip unsupported video_url/audio_url blocks for this provider
        const sanitizedMessages = sanitizeMessagesForProvider(messages, provider);

        if (verbose) {
          logger.info({
            provider: provider.name,
            tier: provider.tier,
            url: resolveChatCompletionsUrl(provider.baseUrl),
            model: provider.modelName,
            messageCount: sanitizedMessages.length,
            toolsEnabled: !!(tools && tools.length > 0),
            temperature,
            maxTokens: resolvedMaxTokens,
          }, '[ModelRouter] Sending chat completion request');
        }

        const start = Date.now();
        const result = await provider.client.chatCompletion(sanitizedMessages, tools, temperature, resolvedMaxTokens);
        const latency = Date.now() - start;

        if (verbose) {
          logger.info({
            provider: provider.name,
            hasToolCalls: Array.isArray(result?.tool_calls) && result.tool_calls.length > 0,
            contentType: Array.isArray(result?.content) ? 'array' : typeof result?.content,
            contentPreview: typeof result?.content === 'string' ? result.content.slice(0, 120) : undefined,
          }, '[ModelRouter] Provider response received');
        }

        // Guard: if the provider returned HTTP 200 but the response has no useful
        // content AND no tool calls, treat it as a failure and try the next provider.
        // Also strip Qwen3-style <think>…</think> blocks before checking emptiness.
        const hasToolCalls = Array.isArray(result?.tool_calls) && result.tool_calls.length > 0;
        const rawContent = typeof result?.content === 'string' ? result.content : '';
        const strippedContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        if (!hasToolCalls && !strippedContent) {
          logger.warn({ provider: provider.name, latency }, '[ModelRouter] Provider returned empty content, trying next');
          this.markProviderFailure(provider.name);
          healthMetrics.recordLLMRequest(provider.name, latency, false);
          lastError = new Error(`Provider "${provider.name}" returned empty content`);
          continue;
        }

        healthMetrics.recordLLMRequest(provider.name, latency, true);
        this.clearProviderCooldown(provider.name);
        // V7.13: Usage may be on the message object for some providers (runtime-only field)
        const usage = this.getUsage(result);
        if (usage) {
          healthMetrics.recordTokenUsage(
            provider.modelName,
            usage.prompt_tokens ?? 0,
            usage.completion_tokens ?? 0
          );
        }

        logger.debug({ provider: provider.name, latency }, '[ModelRouter] Provider succeeded');
        return result;
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(getErrorMessage(error));
        lastError = err;
        this.markProviderFailure(provider.name);
        healthMetrics.recordLLMRequest(provider.name, 0, false);
        logger.warn({ provider: provider.name, err: err.message }, '[ModelRouter] Provider failed, trying next');
      }
    }

    throw lastError ?? new Error('All AI providers failed.');
  }

  /**
   * Sends a streaming chat completion request with automatic failover.
   * Returns an async generator yielding SSE chunks.
   *
   * @param messages    Full conversation history.
   * @param tools       Optional tool definitions.
   * @param temperature Sampling temperature.
   * @param maxTokens   Max tokens.
   * @param tier        Optional model tier preference.
   * @yields            `ChatCompletionChunk` objects as they arrive from the stream.
   */
  async *chatCompletionStream(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7,
    maxTokens?: number,
    tier?: ModelTier,
  ): AsyncGenerator<ChatCompletionChunk> {
    let lastError: Error | null = null;
    const orderedProviders = this.getCandidateProviders(tier);

    for (const provider of orderedProviders) {
      let yieldedAny = false;
      const start = Date.now();
      try {
        if (!provider.baseUrl) throw new Error(`Provider "${provider.name}" has no base URL.`);

        const resolvedMaxTokens = maxTokens ?? getAIRequestConfig(process.env, true).maxTokens;
        // V7.13: Strip unsupported video_url/audio_url blocks for this provider
        const sanitizedMessages = sanitizeMessagesForProvider(messages, provider);

        const stream = provider.client.chatCompletionStream(sanitizedMessages, tools, temperature, resolvedMaxTokens);

        for await (const chunk of stream) {
          yieldedAny = true;
          yield chunk;
        }

        const latency = Date.now() - start;
        healthMetrics.recordLLMRequest(provider.name, latency, true);
        this.clearProviderCooldown(provider.name);

        return; // Successfully streamed from this provider
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(getErrorMessage(error));
        lastError = err;
        this.markProviderFailure(provider.name);
        healthMetrics.recordLLMRequest(provider.name, Date.now() - start, false);
        if (yieldedAny) {
          logger.warn(
            { provider: provider.name, err: err.message },
            '[ModelRouter] Streaming provider failed after yielding chunks; aborting without cross-provider fallback',
          );
          throw err;
        }
        logger.warn({ provider: provider.name, err: err.message }, '[ModelRouter] Streaming provider failed, trying next');
      }
    }

    throw lastError ?? new Error('All AI providers failed (streaming).');
  }

  /** Returns the list of loaded provider configs (useful for /stats display). */
  getProviders(): ProviderConfig[] {
    return this.providers;
  }
}

let singletonRouter: ModelRouter | null = null;

export function getModelRouter(): ModelRouter {
  if (!singletonRouter) {
    singletonRouter = new ModelRouter();
  }
  return singletonRouter;
}

