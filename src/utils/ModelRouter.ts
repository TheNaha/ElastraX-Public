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
 *   AI_{NAME}_BASE_URL   — OpenAI-compatible endpoint (required per provider)
 *   AI_{NAME}_API_KEY    — Bearer token (optional, defaults to 'dummy')
 *   AI_{NAME}_MODEL      — Model identifier
 *
 * Example .env block:
 *   AI_PROVIDERS=modal,gemini
 *   AI_MODAL_BASE_URL=https://your-modal-endpoint.modal.run
 *   AI_MODAL_API_KEY=sk-modal-xxx
 *   AI_MODAL_MODEL=meta-llama/Meta-Llama-3-8B-Instruct
 *   AI_GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
 *   AI_GEMINI_API_KEY=AIzaSy...
 *   AI_GEMINI_MODEL=gemini-2.5-flash
 *   AI_OLLAMA_BASE_URL=http://localhost:11434/v1
 *   AI_OLLAMA_API_KEY=ollama
 *   AI_OLLAMA_MODEL=llama3
 *
 * If AI_PROVIDERS is not set, it falls back to the legacy single-provider setup
 * (AI_API_BASE_URL / AI_API_KEY / AI_MODEL_NAME).
 */

import { logger } from './logger';
import { AIClient } from '../ai/client';
import type { AIChatMessage } from '../ai/client';
import type { ToolDefinition } from '../tools/BaseTool';
import type { ChatCompletionMessage, ChatCompletionChunk, ModelTier } from '../types/ai';
import { healthMetrics } from './HealthMetrics';

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  /** Model tier for multi-model routing. Defaults to 'standard'. */
  tier: ModelTier;
}

/** Internal provider with a pre-built, cached AIClient instance. */
interface ResolvedProvider extends ProviderConfig {
  client: AIClient;
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

/** Loads all provider configs from process.env according to the documented pattern. */
function loadProviders(): ResolvedProvider[] {
  const providerList = process.env.AI_PROVIDERS;

  // Legacy single-provider fallback
  if (!providerList || providerList.trim() === '') {
    const legacyCfBase = buildCloudflareBaseUrl(process.env.AI_CF_ACCOUNT_ID);
    const cfg: ProviderConfig = {
      name: 'default',
      baseUrl: process.env.AI_API_BASE_URL || legacyCfBase,
      apiKey: process.env.AI_API_KEY || process.env.AI_CF_API_TOKEN || 'dummy',
      modelName: process.env.AI_MODEL_NAME || 'meta-llama/Meta-Llama-3-8B-Instruct',
      tier: parseTier(process.env.AI_TIER),
    };
    return [{
      ...cfg,
      client: new AIClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, modelName: cfg.modelName }),
    }];
  }

  return providerList.split(',').map(p => p.trim().toLowerCase()).filter(Boolean).map(name => {
    const upper = name.toUpperCase();
    const cfBase = buildCloudflareBaseUrl(process.env[`AI_${upper}_CF_ACCOUNT_ID`]);
    const cfg: ProviderConfig = {
      name,
      baseUrl: process.env[`AI_${upper}_BASE_URL`] || cfBase,
      apiKey: process.env[`AI_${upper}_API_KEY`] || process.env[`AI_${upper}_CF_API_TOKEN`] || 'dummy',
      modelName: process.env[`AI_${upper}_MODEL`] || 'gpt-4o-mini',
      tier: parseTier(process.env[`AI_${upper}_TIER`]),
    };
    return {
      ...cfg,
      client: new AIClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, modelName: cfg.modelName }),
    };
  });
}

/**
 * Singleton router that tries providers in priority order with automatic failover.
 * Pre-builds and caches AIClient instances at init time for efficiency.
 * Supports tier-based routing for multi-model strategies.
 */
export class ModelRouter {
  private providers: ResolvedProvider[];

  constructor() {
    this.providers = loadProviders();
    if (this.providers.length === 0) {
      throw new Error('No AI providers configured. Set AI_PROVIDERS or AI_API_BASE_URL.');
    }
    logger.info({
      providers: this.providers.map(p => ({ name: p.name, tier: p.tier })),
    }, '[ModelRouter] Loaded providers with cached clients');
  }

  /**
   * Returns providers filtered by tier preference.
   * If a tier is specified, providers matching that tier are tried first,
   * then all others as fallback.
   */
  private getProvidersByTier(tier?: ModelTier): ResolvedProvider[] {
    if (!tier) return this.providers;

    const preferred = this.providers.filter(p => p.tier === tier);
    const fallback = this.providers.filter(p => p.tier !== tier);

    if (preferred.length === 0) {
      logger.debug({ tier }, '[ModelRouter] No providers match requested tier, using all');
      return this.providers;
    }
    return [...preferred, ...fallback];
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
    const orderedProviders = this.getProvidersByTier(tier);

    for (const provider of orderedProviders) {
      try {
        if (!provider.baseUrl) throw new Error(`Provider "${provider.name}" has no base URL.`);

        const resolvedMaxTokens = maxTokens ?? parseInt(process.env.AI_MAX_TOKENS || '2048', 10);

        if (verbose) {
          logger.info({
            provider: provider.name,
            tier: provider.tier,
            url: resolveChatCompletionsUrl(provider.baseUrl),
            model: provider.modelName,
            messageCount: messages.length,
            toolsEnabled: !!(tools && tools.length > 0),
            temperature,
            maxTokens: resolvedMaxTokens,
          }, '[ModelRouter] Sending chat completion request');
        }

        const start = Date.now();
        const result = await provider.client.chatCompletion(messages, tools, temperature, resolvedMaxTokens);
        const latency = Date.now() - start;

        healthMetrics.recordLLMRequest(provider.name, latency, true);

        if (verbose) {
          logger.info({
            provider: provider.name,
            hasToolCalls: Array.isArray(result?.tool_calls) && result.tool_calls.length > 0,
            contentType: Array.isArray(result?.content) ? 'array' : typeof result?.content,
          }, '[ModelRouter] Provider response received');
        }

        logger.debug({ provider: provider.name, latency }, '[ModelRouter] Provider succeeded');
        return result;
      } catch (err: any) {
        lastError = err;
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
    const orderedProviders = this.getProvidersByTier(tier);

    for (const provider of orderedProviders) {
      try {
        if (!provider.baseUrl) throw new Error(`Provider "${provider.name}" has no base URL.`);

        const resolvedMaxTokens = maxTokens ?? parseInt(process.env.AI_MAX_TOKENS || '2048', 10);
        const start = Date.now();

        yield* provider.client.chatCompletionStream(messages, tools, temperature, resolvedMaxTokens);

        const latency = Date.now() - start;
        healthMetrics.recordLLMRequest(provider.name, latency, true);
        return; // Successfully streamed from this provider
      } catch (err: any) {
        lastError = err;
        healthMetrics.recordLLMRequest(provider.name, 0, false);
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
