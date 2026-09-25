import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { ToolDefinition } from '../tools/BaseTool';
import type {
  ChatCompletionChunkChoice,
  ChatCompletionMessage,
  StreamingToolCallDelta,
  TokenUsage,
  ToolCall,
} from '../types/ai';
import { getAIRequestConfig } from '../config/runtime';
import { AIProtocolError, AINoChoiceError } from './errors';
import { SSEDecoder, type SSEDecoderOptions } from './sse';
import {
  isToolCall,
  normalizeTokenUsage,
  type AIStreamChunk,
  type ChatCompletionEnvelope,
  type FinishReason,
} from './types';

export interface AIContentPart {
  type: 'text' | 'image_url' | 'video_url' | 'audio_url';
  text?: string;
  image_url?: { url: string };
  video_url?: { url: string };
  audio_url?: { url: string };
}

export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | AIContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface AIClientConfig {
  baseUrl?: string;
  apiKey?: string;
  modelName?: string;
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  includeStreamUsage?: boolean;
  supportsParallelToolCalls?: boolean;
  sse?: SSEDecoderOptions;
}

const log = logger.child({ module: 'AIClient' });

function withTimeout(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeFinishReason(value: unknown, context: string): FinishReason | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new AIProtocolError('invalid_response', `${context} has an invalid finish reason.`);
  }
  return value;
}

function normalizeAssistantContent(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value.map(part => {
      if (typeof part === 'string') return part;
      if (isRecord(part) && typeof part.text === 'string') return part.text;
      throw new AIProtocolError('invalid_response', 'Assistant content array contains an invalid part.');
    }).filter(Boolean).join('');
    return text || null;
  }
  throw new AIProtocolError('invalid_response', 'Assistant message content must be text or null.');
}

function normalizeMessage(value: unknown): ChatCompletionMessage {
  if (!isRecord(value) || value.role !== 'assistant') {
    throw new AIProtocolError('invalid_response', 'Chat completion response has no valid assistant message.');
  }
  if (value.tool_calls !== undefined && !Array.isArray(value.tool_calls)) {
    throw new AIProtocolError('invalid_response', 'Assistant tool_calls must be an array.');
  }
  if (Array.isArray(value.tool_calls) && !value.tool_calls.every(isToolCall)) {
    throw new AIProtocolError('invalid_response', 'Assistant response contains an invalid tool call.');
  }

  const message: ChatCompletionMessage = {
    role: 'assistant',
    content: normalizeAssistantContent(value.content),
  };
  if (Array.isArray(value.tool_calls)) message.tool_calls = value.tool_calls;
  if (value.refusal === null || typeof value.refusal === 'string') message.refusal = value.refusal;
  if (typeof value.output_text === 'string') message.output_text = value.output_text;
  return message;
}

function usageOrThrow(value: unknown, context: string): TokenUsage | null {
  try {
    return normalizeTokenUsage(value);
  } catch (error: unknown) {
    throw new AIProtocolError('invalid_response', `${context} has invalid token usage.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseJsonResponse(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AIProtocolError('invalid_response', 'Chat completion response must be a JSON object.');
  }
  return value;
}

export class AIClient {
  private baseUrl: string;
  private apiKey: string;
  private modelName: string;
  private readonly maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  private readonly includeStreamUsage: boolean;
  private readonly supportsParallelToolCalls?: boolean;
  private readonly sseOptions: SSEDecoderOptions;

  constructor(config?: AIClientConfig) {
    this.baseUrl = config?.baseUrl ?? process.env.AI_API_BASE_URL ?? '';
    this.apiKey = config?.apiKey || process.env.AI_API_KEY || '';
    this.modelName = config?.modelName || process.env.AI_MODEL_NAME || 'meta-llama/Meta-Llama-3-8B-Instruct';
    this.maxTokensParam = config?.maxTokensParam === 'max_completion_tokens'
      ? 'max_completion_tokens'
      : 'max_tokens';
    this.includeStreamUsage = config?.includeStreamUsage ?? true;
    this.supportsParallelToolCalls = config?.supportsParallelToolCalls;
    this.sseOptions = { ...(config?.sse ?? {}) };

    if (!this.baseUrl || !isValidUrl(this.baseUrl)) {
      log.warn('AI_API_BASE_URL is not configured or is invalid. AI features will not work.');
    }
  }

  private resolveEndpoint(): string {
    if (!this.baseUrl) return '';
    return this.baseUrl.endsWith('/chat/completions')
      ? this.baseUrl
      : `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
  }

  private buildPayload(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7,
    maxTokens?: number,
    stream: boolean = false,
  ): Record<string, unknown> {
    const aiRequestConfig = getAIRequestConfig(process.env, stream);
    const payload: Record<string, unknown> = {
      model: this.modelName,
      messages,
      temperature,
      [this.maxTokensParam]: maxTokens ?? aiRequestConfig.maxTokens,
    };
    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
      if (this.supportsParallelToolCalls !== undefined) {
        payload.parallel_tool_calls = this.supportsParallelToolCalls;
      }
    }
    if (stream) {
      payload.stream = true;
      if (this.includeStreamUsage) payload.stream_options = { include_usage: true };
    }
    return payload;
  }

  private prepareRequest(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7,
    maxTokens?: number,
    stream: boolean = false,
  ): { endpoint: string; payload: Record<string, unknown>; requestId: string } {
    const resolvedMaxTokens = maxTokens ?? getAIRequestConfig(process.env, stream).maxTokens;
    if (!this.baseUrl || !isValidUrl(this.baseUrl)) {
      throw new Error('AI_API_BASE_URL is not configured properly or is invalid.');
    }
    if (!this.apiKey) {
      throw new Error('AI_API_KEY is missing or empty. A valid API key is required.');
    }
    return {
      endpoint: this.resolveEndpoint(),
      payload: this.buildPayload(messages, tools, temperature, resolvedMaxTokens, stream),
      requestId: randomUUID(),
    };
  }

  private headers(requestId: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'X-Request-ID': requestId,
    };
  }

  async chatCompletionEnvelope(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7,
    maxTokens?: number,
  ): Promise<ChatCompletionEnvelope> {
    const { endpoint, payload, requestId } = this.prepareRequest(
      messages,
      tools,
      temperature,
      maxTokens,
      false,
    );
    const startTime = Date.now();

    log.debug(
      { endpoint, model: this.modelName, messageCount: messages.length, hasTools: !!(tools && tools.length) },
      'Sending chat completion request',
    );
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: this.headers(requestId),
      body: JSON.stringify(payload),
      signal: withTimeout(getAIRequestConfig().timeoutMs),
    });

    const elapsed = Date.now() - startTime;
    if (!response.ok) {
      const errText = await response.text();
      log.error({ status: response.status, errText, elapsed }, 'Error response from LLM');
      throw new Error(`LLM API returned ${response.status}: ${errText}`);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error: unknown) {
      throw new AIProtocolError('invalid_response', 'Chat completion response was not valid JSON.', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const data = parseJsonResponse(raw);
    if (!Array.isArray(data.choices) || data.choices.length === 0) {
      const responseId = typeof data.id === 'string' ? data.id : undefined;
      throw new AINoChoiceError('Chat completion response contained no choices.', responseId);
    }
    const first = data.choices[0];
    if (!isRecord(first) || !isRecord(first.message)) {
      throw new AIProtocolError('invalid_response', 'Chat completion response choice has no message.');
    }

    const responseId = data.id;
    if (responseId !== undefined && typeof responseId !== 'string') {
      throw new AIProtocolError('invalid_response', 'Chat completion response id must be a string.');
    }
    const model = data.model === undefined ? this.modelName : data.model;
    if (typeof model !== 'string' || model.length === 0) {
      throw new AIProtocolError('invalid_response', 'Chat completion response model must be a non-empty string.');
    }
    const created = data.created === undefined || data.created === null ? null : data.created;
    if (created !== null && (typeof created !== 'number' || !Number.isFinite(created))) {
      throw new AIProtocolError('invalid_response', 'Chat completion response created must be a finite number.');
    }

    const envelope: ChatCompletionEnvelope = {
      message: normalizeMessage(first.message),
      usage: usageOrThrow(data.usage, 'Chat completion response'),
      finishReason: normalizeFinishReason(first.finish_reason, 'Chat completion choice'),
      model,
      requestId: response.headers.get('x-request-id')
        ?? response.headers.get('request-id')
        ?? responseId
        ?? requestId,
      created,
    };
    log.debug(
      { elapsed, tokenUsage: envelope.usage, model: envelope.model, requestId: envelope.requestId },
      'Chat completion response received',
    );
    return envelope;
  }

  async chatCompletion(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7,
    maxTokens?: number,
  ): Promise<ChatCompletionMessage> {
    const envelope = await this.chatCompletionEnvelope(messages, tools, temperature, maxTokens);
    return envelope.message;
  }

  private normalizeStreamChunk(
    value: unknown,
    previous: AIStreamChunk | undefined,
    requestId: string,
  ): AIStreamChunk {
    if (!isRecord(value) || !Array.isArray(value.choices)) {
      throw new AIProtocolError('invalid_chunk', 'SSE data must contain a choices array.');
    }

    const choices: ChatCompletionChunkChoice[] = value.choices.map((entry): ChatCompletionChunkChoice => {
      if (!isRecord(entry) || !isRecord(entry.delta)) {
        throw new AIProtocolError('invalid_chunk', 'SSE choice is missing its delta object.');
      }
      const choiceIndex = entry.index;
      if (typeof choiceIndex !== 'number' || !Number.isInteger(choiceIndex)) {
        throw new AIProtocolError('invalid_chunk', 'SSE choice index must be an integer.');
      }
      const delta: ChatCompletionChunkChoice['delta'] = {};
      if (entry.delta.role !== undefined) {
        if (entry.delta.role !== 'assistant') {
          throw new AIProtocolError('invalid_chunk', 'SSE delta role must be assistant.');
        }
        delta.role = 'assistant';
      }
      if (entry.delta.content !== undefined && entry.delta.content !== null) {
        if (typeof entry.delta.content !== 'string') {
          throw new AIProtocolError('invalid_chunk', 'SSE delta content must be a string or null.');
        }
        delta.content = entry.delta.content;
      } else if (entry.delta.content === null) {
        delta.content = null;
      }
      if (entry.delta.tool_calls !== undefined) {
        if (!Array.isArray(entry.delta.tool_calls)) {
          throw new AIProtocolError('invalid_chunk', 'SSE tool_calls must be an array.');
        }
        delta.tool_calls = entry.delta.tool_calls.map((fragment): StreamingToolCallDelta => {
          if (!isRecord(fragment)) {
            throw new AIProtocolError('invalid_chunk', 'SSE tool-call fragment must be an object.');
          }
          const fragmentIndex = fragment.index;
          if (typeof fragmentIndex !== 'number' || !Number.isInteger(fragmentIndex) || fragmentIndex < 0) {
            throw new AIProtocolError('invalid_chunk', 'SSE tool-call fragment has an invalid index.');
          }
          const normalized: StreamingToolCallDelta = { index: fragmentIndex };
          if (fragment.id !== undefined) {
            if (typeof fragment.id !== 'string') {
              throw new AIProtocolError('invalid_chunk', 'SSE tool-call id must be a string.');
            }
            normalized.id = fragment.id;
          }
          if (fragment.type !== undefined) {
            if (fragment.type !== 'function') {
              throw new AIProtocolError('invalid_chunk', 'SSE tool-call type must be function.');
            }
            normalized.type = 'function';
          }
          if (fragment.function !== undefined) {
            if (!isRecord(fragment.function)) {
              throw new AIProtocolError('invalid_chunk', 'SSE tool-call function must be an object.');
            }
            const fn: NonNullable<StreamingToolCallDelta['function']> = {};
            if (fragment.function.name !== undefined) {
              if (typeof fragment.function.name !== 'string') {
                throw new AIProtocolError('invalid_chunk', 'SSE tool-call name must be a string.');
              }
              fn.name = fragment.function.name;
            }
            if (fragment.function.arguments !== undefined) {
              if (typeof fragment.function.arguments !== 'string') {
                throw new AIProtocolError('invalid_chunk', 'SSE tool-call arguments must be a string.');
              }
              fn.arguments = fragment.function.arguments;
            }
            normalized.function = fn;
          }
          return normalized;
        });
      }

      return {
        index: choiceIndex,
        delta,
        finish_reason: normalizeFinishReason(entry.finish_reason, 'SSE choice'),
      };
    });

    const id = value.id ?? previous?.id ?? requestId;
    const model = value.model ?? previous?.model ?? this.modelName;
    const created = value.created ?? previous?.created ?? 0;
    if (typeof id !== 'string' || typeof model !== 'string') {
      throw new AIProtocolError('invalid_chunk', 'SSE chunk id and model must be strings.');
    }
    if (typeof created !== 'number' || !Number.isFinite(created)) {
      throw new AIProtocolError('invalid_chunk', 'SSE chunk created must be a finite number.');
    }

    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices,
      usage: usageOrThrow(value.usage, 'SSE chunk'),
    };
  }

  async *chatCompletionStream(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7,
    maxTokens?: number,
  ): AsyncGenerator<AIStreamChunk> {
    const { endpoint, payload, requestId } = this.prepareRequest(
      messages,
      tools,
      temperature,
      maxTokens,
      true,
    );
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: this.headers(requestId),
      body: JSON.stringify(payload),
      signal: withTimeout(getAIRequestConfig(process.env, true).timeoutMs),
    });

    if (!response.ok) {
      const errText = await response.text();
      log.error({ status: response.status, errText }, 'Streaming LLM request failed');
      throw new Error(`LLM API returned ${response.status}: ${errText}`);
    }
    if (!response.body) {
      throw new Error('Response body is null — streaming not supported by this endpoint.');
    }

    const reader = response.body.getReader();
    const textDecoder = new TextDecoder();
    const sseDecoder = new SSEDecoder(this.sseOptions);
    let previous: AIStreamChunk | undefined;
    let sawChunk = false;
    let sawFinish = false;
    let sawDone = false;
    let cancelReader = false;

    const decodeEvents = (events: ReturnType<SSEDecoder['push']>): AIStreamChunk[] => {
      const chunks: AIStreamChunk[] = [];
      for (const event of events) {
        if (event.data.trim() === '[DONE]') {
          sawDone = true;
          cancelReader = true;
          break;
        }
        if (!event.data.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch (error: unknown) {
          throw new AIProtocolError('invalid_sse', 'SSE event data was not valid JSON.', {
            cause: error instanceof Error ? error.message : String(error),
          });
        }
        const chunk = this.normalizeStreamChunk(parsed, previous, requestId);
        previous = chunk;
        sawChunk = true;
        if (chunk.choices.some(choice => choice.finish_reason !== null)) sawFinish = true;
        chunks.push(chunk);
      }
      return chunks;
    };

    try {
      while (!sawDone) {
        const { done, value } = await reader.read();
        if (done) {
          const decoded = textDecoder.decode();
          if (decoded) {
            for (const chunk of decodeEvents(sseDecoder.push(decoded))) yield chunk;
          }
          for (const chunk of decodeEvents(sseDecoder.finish())) yield chunk;
          break;
        }
        const decoded = textDecoder.decode(value, { stream: true });
        if (decoded) {
          for (const chunk of decodeEvents(sseDecoder.push(decoded))) yield chunk;
        }
      }

      if (!sawChunk) {
        throw new AIProtocolError('empty_stream', 'LLM stream completed without any response chunks.');
      }
      if (!sawDone && !sawFinish) {
        throw new AIProtocolError('incomplete_stream', 'LLM stream ended without a finish reason or [DONE].');
      }
    } finally {
      if (cancelReader) {
        try {
          await reader.cancel();
        } catch (error: unknown) {
          log.trace({ err: error }, 'Terminal SSE stream cancellation failed');
        }
      }
      reader.releaseLock();
    }
  }
}

export { StreamingToolCallAccumulator } from './streaming';
export type { AIStreamChunk, ChatCompletionEnvelope, FinishReason } from './types';
