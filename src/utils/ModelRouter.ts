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
import type { AIChatMessage } from '../ai/client';
import type { ToolDefinition } from '../tools/BaseTool';

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
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

/** Loads all provider configs from process.env according to the documented pattern. */
function loadProviders(): ProviderConfig[] {
  const providerList = process.env.AI_PROVIDERS;

  // Legacy single-provider fallback
  if (!providerList || providerList.trim() === '') {
    const legacyCfBase = buildCloudflareBaseUrl(process.env.AI_CF_ACCOUNT_ID);
    return [{
      name: 'default',
      baseUrl: process.env.AI_API_BASE_URL || legacyCfBase,
      apiKey: process.env.AI_API_KEY || process.env.AI_CF_API_TOKEN || 'dummy',
      modelName: process.env.AI_MODEL_NAME || 'meta-llama/Meta-Llama-3-8B-Instruct',
    }];
  }

  return providerList.split(',').map(p => p.trim().toLowerCase()).filter(Boolean).map(name => {
    const upper = name.toUpperCase();
    const cfBase = buildCloudflareBaseUrl(process.env[`AI_${upper}_CF_ACCOUNT_ID`]);
    return {
      name,
      baseUrl: process.env[`AI_${upper}_BASE_URL`] || cfBase,
      apiKey: process.env[`AI_${upper}_API_KEY`] || process.env[`AI_${upper}_CF_API_TOKEN`] || 'dummy',
      modelName: process.env[`AI_${upper}_MODEL`] || 'gpt-4o-mini',
    };
  });
}

/**
 * Sends a single chat completion request to one specific provider.
 * Returns the raw message object from choices[0] or throws on failure.
 */
async function callProvider(
  provider: ProviderConfig,
  messages: AIChatMessage[],
  tools?: ToolDefinition[],
  temperature: number = 0.7,
): Promise<any> {
  if (!provider.baseUrl) {
    throw new Error(`Provider "${provider.name}" has no base URL configured.`);
  }

  const url = resolveChatCompletionsUrl(provider.baseUrl);
  const verbose = process.env.AI_VERBOSE_LOGS === 'true';

  const body: Record<string, any> = {
    model: provider.modelName,
    messages,
    temperature,
    max_tokens: parseInt(process.env.AI_MAX_TOKENS || '2048', 10),
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  if (verbose) {
    logger.info({
      provider: provider.name,
      url,
      model: provider.modelName,
      messageCount: messages.length,
      toolsEnabled: !!(tools && tools.length > 0),
      temperature,
    }, '[ModelRouter] Sending chat completion request');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(parseInt(process.env.AI_TIMEOUT_MS || '60000', 10)),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    const trimmed = errorText.length > 600 ? `${errorText.slice(0, 600)}...` : errorText;
    throw new Error(`HTTP ${response.status} (${provider.name}): ${trimmed}`);
  }

  const data: any = await response.json();

  if (verbose) {
    logger.info({
      provider: provider.name,
      hasChoices: Array.isArray(data?.choices),
      choiceCount: Array.isArray(data?.choices) ? data.choices.length : 0,
      usage: data?.usage,
    }, '[ModelRouter] Provider response received');
  }

  if (!data.choices || data.choices.length === 0) {
    throw new Error('No choices returned from provider.');
  }

  return data.choices[0].message;
}

/**
 * Singleton router that tries providers in priority order with automatic failover.
 */
export class ModelRouter {
  private providers: ProviderConfig[];

  constructor() {
    this.providers = loadProviders();
    if (this.providers.length === 0) {
      throw new Error('No AI providers configured. Set AI_PROVIDERS or AI_API_BASE_URL.');
    }
    logger.info({ providers: this.providers.map(p => p.name) }, '[ModelRouter] Loaded providers');
  }

  /**
   * Sends a chat completion request, trying each provider in order until one succeeds.
   *
   * @param messages    Full conversation history including system prompt.
   * @param tools       Optional LLM function-calling tool definitions.
   * @param temperature Sampling temperature.
   * @returns           The raw message object from choices[0].
   * @throws            If ALL providers fail, re-throws the last error.
   */
  async chatCompletion(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7,
  ): Promise<any> {
    let lastError: Error | null = null;

    for (const provider of this.providers) {
      try {
        const start = Date.now();
        const result = await callProvider(provider, messages, tools, temperature);
        const latency = Date.now() - start;
        logger.debug({ provider: provider.name, latency }, '[ModelRouter] Provider succeeded');
        return result;
      } catch (err: any) {
        lastError = err;
        logger.warn({ provider: provider.name, err: err.message }, '[ModelRouter] Provider failed, trying next');
      }
    }

    throw lastError ?? new Error('All AI providers failed.');
  }

  /** Returns the list of loaded provider configs (useful for /stats display). */
  getProviders(): ProviderConfig[] {
    return this.providers;
  }
}
