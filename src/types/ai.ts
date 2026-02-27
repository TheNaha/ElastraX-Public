/**
 * @file src/types/ai.ts
 * @description Typed interfaces for OpenAI-compatible LLM API requests and responses.
 *
 * These types replace the `any` types previously used throughout the codebase
 * for LLM chat completion requests and responses. They cover:
 *  - Standard (non-streaming) chat completion responses
 *  - Streaming (SSE) chat completion chunks
 *  - Tool/function calling structures
 *  - Token usage statistics
 *
 * All types follow the OpenAI API specification and are compatible with any
 * OpenAI-compatible endpoint (Gemini, Ollama, Modal, Cloudflare Workers AI, etc.).
 */

// ─── Tool Calling ──────────────────────────────────────────────────────────────

/** The function portion of a tool call, containing the name and JSON-encoded arguments. */
export interface ToolCallFunction {
  name: string;
  /** JSON-encoded string of the function arguments. Must be parsed with JSON.parse(). */
  arguments: string;
}

/** A single tool call requested by the assistant in a chat completion response. */
export interface ToolCall {
  /** Unique identifier for this tool call, used to match tool results back. */
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

// ─── Non-Streaming Response ────────────────────────────────────────────────────

/** The assistant's message in a chat completion response. */
export interface ChatCompletionMessage {
  role: 'assistant';
  /** Text content of the response. Null when the model only produces tool calls. */
  content: string | null;
  /** Tool calls requested by the assistant (function calling). */
  tool_calls?: ToolCall[];
  /** Model refusal message (e.g., content policy violation). */
  refusal?: string | null;
  /** Alternative text field used by some providers (e.g., OpenAI Responses API). */
  output_text?: string;
}

/** Token usage statistics returned by the API. */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** A single choice in a chat completion response. */
export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: string | null;
}

/** Full chat completion API response (non-streaming). */
export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: TokenUsage;
}

// ─── Streaming Response (SSE) ──────────────────────────────────────────────────

/** Partial tool call fragment received during streaming. */
export interface StreamingToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

/** Delta object in a streaming chunk — contains partial content or tool call fragments. */
export interface ChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string | null;
  tool_calls?: StreamingToolCallDelta[];
}

/** A single choice in a streaming chunk. */
export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: string | null;
}

/** A single SSE chunk from a streaming chat completion response. */
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

// ─── Model Tier ────────────────────────────────────────────────────────────────

/**
 * Model tier for multi-model routing.
 * - 'fast'     — Cheap/small models for simple tasks (ping, menu, summarization)
 * - 'standard' — Default tier for general conversation and tool calling
 * - 'powerful' — Large/expensive models for complex reasoning
 */
export type ModelTier = 'fast' | 'standard' | 'powerful';
