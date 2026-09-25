import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
  TokenUsage,
  ToolCall,
} from '../types/ai';

export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'function_call'
  | string;

export interface ChatCompletionEnvelope {
  message: ChatCompletionMessage;
  usage: TokenUsage | null;
  finishReason: FinishReason | null;
  model: string;
  requestId: string;
  created: number | null;
  provider?: {
    name: string;
    key: string;
  };
}

export interface AIStreamChunk extends ChatCompletionChunk {
  usage?: TokenUsage | null;
}

export interface ToolCallAccumulator {
  index: number;
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export function normalizeTokenUsage(value: unknown): TokenUsage | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Token usage must be an object.');
  }

  const usage = value as Record<string, unknown>;
  const read = (key: string): number => {
    const raw = usage[key];
    if (raw === undefined || raw === null) return 0;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      throw new TypeError(`Token usage field ${key} must be a non-negative finite number.`);
    }
    return raw;
  };

  const promptTokens = read('prompt_tokens');
  const completionTokens = read('completion_tokens');
  const reportedTotal = read('total_tokens');
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: reportedTotal > 0 ? reportedTotal : promptTokens + completionTokens,
  };
}

export function isToolCall(value: unknown): value is ToolCall {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.type !== 'function') return false;
  const fn = candidate.function;
  if (typeof fn !== 'object' || fn === null) return false;
  const typed = fn as Record<string, unknown>;
  return typeof typed.name === 'string' && typeof typed.arguments === 'string';
}
