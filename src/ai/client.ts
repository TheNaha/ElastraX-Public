/**
 * @file src/ai/client.ts
 * @description OpenAI-compatible AI client used by the ElastraX agent.
 *
 * This module provides:
 *  - `AIChatMessage` — the canonical multi-modal chat message shape sent to the LLM.
 *  - `AIClientConfig` — optional constructor overrides for the base URL, API key, and model.
 *  - `AIClient` — a thin HTTP wrapper around any OpenAI-compatible `/chat/completions`
 *    endpoint (e.g., a self-hosted Llama instance via Modal, or Google Gemini via its
 *    OpenAI-compatible gateway at https://generativelanguage.googleapis.com/v1beta/openai/).
 *
 * Configuration (resolved in priority order):
 *   1. Constructor `config` argument
 *   2. Environment variables: AI_API_BASE_URL, AI_API_KEY, AI_MODEL_NAME
 *   3. Hardcoded defaults (Meta-Llama-3-8B-Instruct)
 */

/** A single chat participant message supporting text, image, video, and audio content types. */
export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{
    type: 'text' | 'image_url' | 'video_url' | 'audio_url';
    text?: string;
    image_url?: { url: string };
    video_url?: { url: string };
    audio_url?: { url: string };
  }>;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

import { logger } from '../utils/logger';
import { ToolDefinition } from '../tools/BaseTool';
import type { ChatCompletionMessage, ChatCompletionResponse, ChatCompletionChunk } from '../types/ai';

/** Checks whether a string is a syntactically valid URL. */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** Optional constructor overrides — any omitted field falls back to environment variables. */
export interface AIClientConfig {
  baseUrl?: string;
  apiKey?: string;
  modelName?: string;
}

/**
 * Thin HTTP wrapper around any OpenAI-compatible `/chat/completions` endpoint.
 *
 * Instantiate once at module level and reuse across requests — the client is
 * stateless between calls so there are no concurrency concerns.
 *
 * @example
 * const ai = new AIClient();
 * const msg = await ai.chatCompletion([{ role: 'user', content: 'Hello!' }]);
 */
export class AIClient {
  private baseUrl: string;
  private apiKey: string;
  private modelName: string;

  constructor(config?: AIClientConfig) {
    // If no URL is provided, it falls back to empty string or env var
    // Alternatively, for Google AI Studio (Gemini), use: "https://generativelanguage.googleapis.com/v1beta/openai/"
    this.baseUrl = config?.baseUrl || process.env.AI_API_BASE_URL || '';
    this.apiKey = config?.apiKey || process.env.AI_API_KEY || 'dummy';
    // Model name defaults to the Llama 3 model deployed on Modal. 
    // If using Gemini, set this to e.g., "gemini-2.5-flash"
    this.modelName = config?.modelName || process.env.AI_MODEL_NAME || 'meta-llama/Meta-Llama-3-8B-Instruct';

    if (!this.baseUrl || !isValidUrl(this.baseUrl)) {
      logger.warn('AI_API_BASE_URL is not configured or is invalid. AI features will not work.');
    }
  }

  /**
   * Send a chat-completion request to the configured LLM endpoint.
   *
   * @param messages    The full conversation history to send, including system prompt.
   * @param tools       Optional array of OpenAI-compatible tool definitions for function calling.
   * @param temperature Sampling temperature (0 = deterministic, 2 = very creative). Defaults to 0.7.
   * @returns           The raw `message` object from `choices[0]`, which may include
   *                    `content` (text) and/or `tool_calls` (function-call requests).
   * @throws            If the endpoint URL is invalid or the HTTP response is not OK.
   */
  /** Resolves the full endpoint URL for chat completions. */
  private resolveEndpoint(): string {
    return this.baseUrl.endsWith('/chat/completions')
      ? this.baseUrl
      : `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
  }

  /** Builds the request payload for a chat completion. */
  private buildPayload(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7,
    maxTokens?: number,
    stream: boolean = false,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: this.modelName,
      messages,
      temperature,
      max_tokens: maxTokens ?? parseInt(process.env.AI_MAX_TOKENS || '2048', 10),
    };
    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }
    if (stream) {
      payload.stream = true;
    }
    return payload;
  }

  /**
   * Send a chat-completion request to the configured LLM endpoint.
   *
   * @param messages    The full conversation history to send, including system prompt.
   * @param tools       Optional array of OpenAI-compatible tool definitions for function calling.
   * @param temperature Sampling temperature (0 = deterministic, 2 = very creative). Defaults to 0.7.
   * @param maxTokens   Maximum tokens to generate.
   * @returns           The typed `ChatCompletionMessage` from `choices[0]`.
   * @throws            If the endpoint URL is invalid or the HTTP response is not OK.
   */
  async chatCompletion(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7,
    maxTokens: number = parseInt(process.env.AI_MAX_TOKENS || '2048', 10)
  ): Promise<ChatCompletionMessage> {
    if (!this.baseUrl || !isValidUrl(this.baseUrl)) {
      throw new Error('AI_API_BASE_URL is not configured properly or is invalid.');
    }

    const endpoint = this.resolveEndpoint();
    const payload = this.buildPayload(messages, tools, temperature, maxTokens);

    logger.debug({ endpoint, model: this.modelName }, 'Sending request to AI provider...');
    const startTime = Date.now();

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(parseInt(process.env.AI_TIMEOUT_MS || '60000', 10)),
    });

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      const errText = await response.text();
      logger.error({ status: response.status, errText, elapsed }, 'Error response from LLM');
      throw new Error(`LLM API returned ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    logger.debug({ elapsed, tokenUsage: data.usage }, 'Received response from AI provider');

    const msg = data.choices?.[0]?.message;
    return msg ?? { role: 'assistant', content: 'No response generated.' };
  }

  /**
   * Send a streaming chat-completion request.
   * Returns an async generator yielding `ChatCompletionChunk` objects as they arrive.
   *
   * @param messages    The full conversation history to send.
   * @param tools       Optional tool definitions.
   * @param temperature Sampling temperature.
   * @param maxTokens   Maximum tokens to generate.
   * @yields            Individual SSE chunks parsed as `ChatCompletionChunk`.
   */
  async *chatCompletionStream(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7,
    maxTokens: number = parseInt(process.env.AI_MAX_TOKENS || '2048', 10)
  ): AsyncGenerator<ChatCompletionChunk> {
    if (!this.baseUrl || !isValidUrl(this.baseUrl)) {
      throw new Error('AI_API_BASE_URL is not configured properly or is invalid.');
    }

    const endpoint = this.resolveEndpoint();
    const payload = this.buildPayload(messages, tools, temperature, maxTokens, true);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(parseInt(process.env.AI_TIMEOUT_MS || '120000', 10)),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM API returned ${response.status}: ${errText}`);
    }

    if (!response.body) {
      throw new Error('Response body is null — streaming not supported by this endpoint.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue; // skip empty lines and comments
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          try {
            yield JSON.parse(data) as ChatCompletionChunk;
          } catch {
            logger.debug({ raw: data }, 'Failed to parse SSE chunk');
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
