import { logger } from './logger';
import { AIClient } from '../ai/client';
import type { AIChatMessage, AIContentPart } from '../ai/client';
import { AIProtocolError, AllProvidersOpenError } from '../ai/errors';
import type { AIStreamChunk, ChatCompletionEnvelope } from '../ai/types';
import type { ToolDefinition } from '../tools/BaseTool';
import type { ChatCompletionMessage, ModelTier } from '../types/ai';
import { healthMetrics } from './HealthMetrics';
import { getErrorMessage } from './errorUtils';
import { getAIRequestConfig, getProviderCooldownMs } from '../config/runtime';
import { resolveLLMProviders } from '../config/llm';

export interface ProviderConfig {
  key: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  tier: ModelTier;
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsAudio: boolean;
  supportsTools: boolean;
  includeStreamUsage: boolean;
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  maxOutputTokens: number | null;
  supportsParallelToolCalls?: boolean;
}

interface ResolvedProvider extends ProviderConfig {
  client: AIClient;
}

export type ProviderCircuitState = 'closed' | 'open' | 'half-open';

export interface ProviderCircuitSnapshot {
  key: string;
  state: ProviderCircuitState;
  failures: number;
  openUntil: number;
  probeInFlight: boolean;
}

export interface ModelRouterOptions {
  now?: () => number;
  random?: () => number;
}

interface CircuitEntry {
  state: ProviderCircuitState;
  failures: number;
  openUntil: number;
  probeInFlight: boolean;
}

export interface ProviderMessageCapabilities {
  supportsImage?: boolean;
  supportsVideo: boolean;
  supportsAudio: boolean;
}

export interface AdaptedChatRequest {
  messages: AIChatMessage[];
  tools?: ToolDefinition[];
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, '');
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function optionalEnvBoolean(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

function envPositiveInteger(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function loadProviders(): ResolvedProvider[] {
  const targets = resolveLLMProviders();
  const usedKeys = new Set<string>();

  return targets.map(target => {
    const upper = target.name.toUpperCase();
    const generic = target.name === 'default' ? '' : `_${upper}`;
    const readCapability = (name: string, fallback: boolean): boolean => (
      envBoolean(`AI${generic}_${name}`, envBoolean(`AI_${name}`, fallback))
    );
    let key = target.key;
    if (usedKeys.has(key)) {
      let suffix = 2;
      while (usedKeys.has(`${key}#${suffix}`)) suffix++;
      key = `${key}#${suffix}`;
    }
    usedKeys.add(key);

    const tokenParamRaw = (
      process.env[`AI${generic}_MAX_TOKENS_PARAM`]?.trim()
      ?? process.env.AI_MAX_TOKENS_PARAM?.trim()
    );
    const parallelTools = (
      optionalEnvBoolean(`AI${generic}_SUPPORTS_PARALLEL_TOOLS`)
      ?? optionalEnvBoolean('AI_SUPPORTS_PARALLEL_TOOLS')
    );
    const config: ProviderConfig = {
      key,
      name: target.name,
      baseUrl: target.baseUrl,
      apiKey: target.apiKey || 'dummy',
      modelName: target.modelName,
      tier: target.tier,
      supportsImage: readCapability('SUPPORTS_IMAGE', true),
      supportsVideo: target.supportsVideo,
      supportsAudio: target.supportsAudio,
      supportsTools: readCapability('SUPPORTS_TOOLS', true),
      includeStreamUsage: readCapability('STREAM_USAGE', true),
      maxTokensParam: tokenParamRaw === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens',
      maxOutputTokens: (
        envPositiveInteger(`AI${generic}_MAX_OUTPUT_TOKENS`)
        ?? envPositiveInteger('AI_MAX_OUTPUT_TOKENS')
      ),
      ...(parallelTools === undefined ? {} : { supportsParallelToolCalls: parallelTools }),
    };
    return {
      ...config,
      client: new AIClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        modelName: config.modelName,
        maxTokensParam: config.maxTokensParam,
        includeStreamUsage: config.includeStreamUsage,
        supportsParallelToolCalls: config.supportsParallelToolCalls,
      }),
    };
  });
}

export function sanitizeMessagesForProvider(
  messages: AIChatMessage[],
  provider: ProviderMessageCapabilities,
): AIChatMessage[] {
  if (
    provider.supportsImage !== false
    && provider.supportsVideo
    && provider.supportsAudio
  ) {
    return messages;
  }

  return messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    const sanitized: AIContentPart[] = [];
    for (const part of message.content) {
      if (part?.type === 'image_url' && provider.supportsImage === false) {
        sanitized.push({ type: 'text', text: '[Image attached — not supported by this provider]' });
      } else if (part?.type === 'video_url' && !provider.supportsVideo) {
        sanitized.push({ type: 'text', text: '[Video attached — not supported by this provider]' });
      } else if (part?.type === 'audio_url' && !provider.supportsAudio) {
        sanitized.push({ type: 'text', text: '[Audio attached — not supported by this provider]' });
      } else {
        sanitized.push(part);
      }
    }
    return { ...message, content: sanitized };
  });
}

function removeToolProtocol(messages: AIChatMessage[]): AIChatMessage[] {
  return messages.flatMap(message => {
    if (message.role === 'tool') {
      const content = typeof message.content === 'string'
        ? message.content
        : message.content.map(part => part.text ?? `[${part.type}]`).join(' ');
      return [{
        role: 'user' as const,
        content: `[Tool result${message.name ? ` ${message.name}` : ''}]: ${content}`,
      }];
    }
    if (message.role !== 'assistant' || !message.tool_calls?.length) return [message];
    const { tool_calls: toolCalls, ...withoutToolCalls } = message;
    const names = toolCalls.map(call => call.function.name).filter(Boolean).join(', ');
    return [{
      ...withoutToolCalls,
      content: typeof withoutToolCalls.content === 'string' && withoutToolCalls.content.length > 0
        ? withoutToolCalls.content
        : `[Tool calls omitted: ${names}]`,
    }];
  });
}

export function adaptChatRequest(
  messages: AIChatMessage[],
  tools: ToolDefinition[] | undefined,
  provider: Pick<ProviderConfig, 'supportsImage' | 'supportsVideo' | 'supportsAudio' | 'supportsTools'>,
): AdaptedChatRequest {
  const sanitized = sanitizeMessagesForProvider(messages, provider);
  const adapted: AdaptedChatRequest = {
    messages: provider.supportsTools ? sanitized : removeToolProtocol(sanitized),
  };
  if (tools && tools.length > 0 && provider.supportsTools) adapted.tools = tools;
  return adapted;
}

function usefulText(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function hasUsefulResponse(message: ChatCompletionMessage): boolean {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  if (typeof message.refusal === 'string' && usefulText(message.refusal).length > 0) return true;
  const content = typeof message.content === 'string' ? message.content : message.output_text ?? '';
  return usefulText(content).length > 0;
}

export class ModelRouter {
  private providers: ResolvedProvider[];
  private readonly circuits = new Map<string, CircuitEntry>();
  private readonly now: () => number;
  private readonly random: () => number;
  private static readonly CIRCUIT_BREAKER_THRESHOLD = 5;

  constructor(options: ModelRouterOptions = {}) {
    this.providers = loadProviders();
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    if (this.providers.length === 0) {
      throw new Error('No AI providers configured. Set AI_PROVIDERS or AI_API_BASE_URL.');
    }
    logger.info({
      providers: this.providers.map(provider => ({
        key: provider.key,
        name: provider.name,
        tier: provider.tier,
        supportsImage: provider.supportsImage,
        supportsVideo: provider.supportsVideo,
        supportsAudio: provider.supportsAudio,
        supportsTools: provider.supportsTools,
      })),
    }, '[ModelRouter] Loaded providers with cached clients');
  }

  private getProvidersByTier(tier?: ModelTier): ResolvedProvider[] {
    if (!tier) return this.providers;
    const preferred: ResolvedProvider[] = [];
    const fallback: ResolvedProvider[] = [];
    for (const provider of this.providers) {
      if (provider.tier === tier) preferred.push(provider);
      else fallback.push(provider);
    }
    if (preferred.length === 0) {
      logger.debug({ tier }, '[ModelRouter] No providers match requested tier, using all');
      return this.providers;
    }
    return preferred.concat(fallback);
  }

  private getCircuit(providerKey: string): CircuitEntry {
    const existing = this.circuits.get(providerKey);
    if (existing) return existing;
    const created: CircuitEntry = {
      state: 'closed',
      failures: 0,
      openUntil: 0,
      probeInFlight: false,
    };
    this.circuits.set(providerKey, created);
    return created;
  }

  private getCandidateProviders(tier?: ModelTier): ResolvedProvider[] {
    const orderedProviders = this.getProvidersByTier(tier);
    const now = this.now();
    const available: ResolvedProvider[] = [];
    const skipped: string[] = [];

    for (const provider of orderedProviders) {
      const circuit = this.getCircuit(provider.key);
      if (circuit.state === 'open' && now < circuit.openUntil) {
        skipped.push(`${provider.name}(open)`);
        continue;
      }
      if (circuit.state === 'open') {
        circuit.state = 'half-open';
        circuit.probeInFlight = false;
      }
      available.push(provider);
    }

    if (available.length === 0) {
      throw new AllProvidersOpenError(orderedProviders.map(provider => provider.key));
    }
    if (skipped.length > 0) logger.debug({ skipped }, '[ModelRouter] Skipping unavailable provider circuits');
    return available;
  }

  private acquireProvider(provider: ResolvedProvider): boolean {
    const circuit = this.getCircuit(provider.key);
    if (circuit.state !== 'half-open') return true;
    if (circuit.probeInFlight) return false;
    circuit.probeInFlight = true;
    return true;
  }

  private clearProviderCircuit(providerKey: string): void {
    this.circuits.delete(providerKey);
  }

  private markProviderFailure(providerKey: string): void {
    const circuit = this.getCircuit(providerKey);
    if (circuit.state === 'open') return;
    circuit.failures++;
    circuit.probeInFlight = false;
    if (circuit.failures >= ModelRouter.CIRCUIT_BREAKER_THRESHOLD) {
      circuit.state = 'open';
      const jitter = 0.8 + Math.max(0, Math.min(1, this.random())) * 0.4;
      circuit.openUntil = this.now() + Math.max(1, Math.round(getProviderCooldownMs() * jitter));
    }
  }

  getProviderCircuit(providerKey: string): ProviderCircuitSnapshot {
    const circuit = this.getCircuit(providerKey);
    return {
      key: providerKey,
      state: circuit.state,
      failures: circuit.failures,
      openUntil: circuit.openUntil,
      probeInFlight: circuit.probeInFlight,
    };
  }

  private resolveMaxTokens(provider: ProviderConfig, requested?: number, streaming = false): number {
    const configured = requested ?? getAIRequestConfig(process.env, streaming).maxTokens;
    return provider.maxOutputTokens === null
      ? configured
      : Math.min(configured, provider.maxOutputTokens);
  }

  async chatCompletionEnvelope(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7,
    maxTokens?: number,
    tier?: ModelTier,
  ): Promise<ChatCompletionEnvelope> {
    let lastError: Error | null = null;
    let attempted = false;
    const verbose = process.env.AI_VERBOSE_LOGS === 'true';
    const orderedProviders = this.getCandidateProviders(tier);

    for (const provider of orderedProviders) {
      if (!this.acquireProvider(provider)) {
        logger.debug({ provider: provider.name }, '[ModelRouter] Half-open probe already in flight');
        continue;
      }
      attempted = true;
      const start = this.now();
      try {
        if (!provider.baseUrl) throw new Error(`Provider "${provider.name}" has no base URL.`);
        const adapted = adaptChatRequest(messages, tools, provider);
        const resolvedMaxTokens = this.resolveMaxTokens(provider, maxTokens);
        if (verbose) {
          logger.info({
            provider: provider.name,
            providerKey: provider.key,
            tier: provider.tier,
            url: resolveChatCompletionsUrl(provider.baseUrl),
            model: provider.modelName,
            messageCount: adapted.messages.length,
            toolsEnabled: !!adapted.tools?.length,
            temperature,
            maxTokens: resolvedMaxTokens,
          }, '[ModelRouter] Sending chat completion request');
        }

        const envelope = await provider.client.chatCompletionEnvelope(
          adapted.messages,
          adapted.tools,
          temperature,
          resolvedMaxTokens,
        );
        const latency = this.now() - start;
        if (envelope.usage) {
          healthMetrics.recordTokenUsage(
            envelope.model,
            envelope.usage.prompt_tokens,
            envelope.usage.completion_tokens,
            envelope.usage.total_tokens,
          );
        }
        if (!hasUsefulResponse(envelope.message)) {
          throw new AIProtocolError('empty_response', `Provider "${provider.name}" returned no useful content.`);
        }

        healthMetrics.recordLLMRequest(provider.name, latency, true);
        this.clearProviderCircuit(provider.key);
        envelope.provider = { name: provider.name, key: provider.key };
        logger.debug({ provider: provider.name, latency, model: envelope.model }, '[ModelRouter] Provider succeeded');
        return envelope;
      } catch (error: unknown) {
        const latency = this.now() - start;
        const err = error instanceof Error ? error : new Error(getErrorMessage(error));
        lastError = err;
        this.markProviderFailure(provider.key);
        healthMetrics.recordLLMRequest(provider.name, latency, false);
        logger.warn({ provider: provider.name, err: err.message, latency }, '[ModelRouter] Provider failed, trying next');
      }
    }

    if (lastError) throw lastError;
    if (!attempted) throw new AllProvidersOpenError(orderedProviders.map(provider => provider.key));
    throw new Error('All AI providers failed.');
  }

  async chatCompletion(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7,
    maxTokens?: number,
    tier?: ModelTier,
  ): Promise<ChatCompletionMessage> {
    const envelope = await this.chatCompletionEnvelope(messages, tools, temperature, maxTokens, tier);
    return envelope.message;
  }

  async *chatCompletionStream(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7,
    maxTokens?: number,
    tier?: ModelTier,
  ): AsyncGenerator<AIStreamChunk> {
    let lastError: Error | null = null;
    let attempted = false;
    const orderedProviders = this.getCandidateProviders(tier);

    for (const provider of orderedProviders) {
      if (!this.acquireProvider(provider)) {
        logger.debug({ provider: provider.name }, '[ModelRouter] Streaming half-open probe already in flight');
        continue;
      }
      attempted = true;
      const start = this.now();
      let sawChunk = false;
      let sawToolCall = false;
      let accumulatedText = '';
      let usageRecorded = false;
      let latestUsage: AIStreamChunk['usage'] = null;
      let usageModel = provider.modelName;
      const recordUsage = (): void => {
        if (usageRecorded || !latestUsage) return;
        healthMetrics.recordTokenUsage(
          usageModel,
          latestUsage.prompt_tokens,
          latestUsage.completion_tokens,
          latestUsage.total_tokens,
        );
        usageRecorded = true;
      };
      try {
        if (!provider.baseUrl) throw new Error(`Provider "${provider.name}" has no base URL.`);
        const adapted = adaptChatRequest(messages, tools, provider);
        const resolvedMaxTokens = this.resolveMaxTokens(provider, maxTokens, true);
        const stream = provider.client.chatCompletionStream(
          adapted.messages,
          adapted.tools,
          temperature,
          resolvedMaxTokens,
        );

        for await (const chunk of stream) {
          sawChunk = true;
          usageModel = chunk.model || usageModel;
          if (chunk.usage) latestUsage = chunk.usage;
          for (const choice of chunk.choices) {
            if (typeof choice.delta.content === 'string' && choice.delta.content.length > 0) {
              accumulatedText += choice.delta.content;
            }
            if ((choice.delta.tool_calls?.length ?? 0) > 0) {
              sawToolCall = true;
            }
          }
          yield chunk;
        }

        if (!sawChunk || (!sawToolCall && usefulText(accumulatedText).length === 0)) {
          throw new AIProtocolError('empty_response', `Provider "${provider.name}" returned an empty stream.`);
        }
        if (!usageRecorded) {
          recordUsage();
          if (!usageRecorded) {
            logger.debug({ provider: provider.name }, '[ModelRouter] Stream completed without token usage');
          }
        }
        healthMetrics.recordLLMRequest(provider.name, this.now() - start, true);
        this.clearProviderCircuit(provider.key);
        return;
      } catch (error: unknown) {
        recordUsage();
        const err = error instanceof Error ? error : new Error(getErrorMessage(error));
        lastError = err;
        this.markProviderFailure(provider.key);
        healthMetrics.recordLLMRequest(provider.name, this.now() - start, false);
        if (sawToolCall || usefulText(accumulatedText).length > 0) {
          logger.warn(
            { provider: provider.name, err: err.message },
            '[ModelRouter] Streaming provider failed after yielding output; cross-provider fallback is unsafe',
          );
          throw err;
        }
        logger.warn({ provider: provider.name, err: err.message }, '[ModelRouter] Streaming provider failed, trying next');
      }
    }

    if (lastError) throw lastError;
    if (!attempted) throw new AllProvidersOpenError(orderedProviders.map(provider => provider.key));
    throw new Error('All AI providers failed (streaming).');
  }

  getProviders(): Array<Omit<ProviderConfig, 'apiKey'>> {
    return this.providers.map(({ apiKey: _apiKey, ...provider }) => ({ ...provider }));
  }
}

let singletonRouter: ModelRouter | null = null;

export function getModelRouter(): ModelRouter {
  if (!singletonRouter) singletonRouter = new ModelRouter();
  return singletonRouter;
}
