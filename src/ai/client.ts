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
  async chatCompletion(
    messages: AIChatMessage[],
    tools?: ToolDefinition[],
    temperature: number = 0.7
  ): Promise<any> {
    if (!this.baseUrl || !isValidUrl(this.baseUrl)) {
      throw new Error('AI_API_BASE_URL is not configured properly or is invalid.');
    }

    const payload: any = {
      model: this.modelName,
      messages,
      temperature,
      max_tokens: 1000,
    };

    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }

    const endpoint = this.baseUrl.endsWith('/chat/completions') 
      ? this.baseUrl 
      : `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;

    logger.debug({ endpoint, model: this.modelName }, 'Sending request to AI provider...');
    const startTime = Date.now();

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      const errText = await response.text();
      logger.error({ status: response.status, errText, elapsed }, 'Error response from LLM');
      throw new Error(`LLM API returned ${response.status}: ${errText}`);
    }

    const data = await response.json();
    logger.debug({ elapsed, tokenUsage: data.usage }, 'Received response from AI provider');
    
    // Return the entire message object so we can inspect 'tool_calls'
    return data.choices?.[0]?.message || { content: 'No response generated.' };
  }
}
