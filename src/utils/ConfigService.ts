/**
 * @file src/utils/ConfigService.ts
 * @description Merges global defaults with per-room database overrides to produce a
 *              fully resolved runtime configuration for a chat room.
 *
 * Resolution priority (highest to lowest):
 *  1. Per-room value stored in the `chat_rooms` table (set via `/config set …`).
 *  2. Environment variable (AI_TEMPERATURE, CONTEXT_MESSAGE_LIMIT, etc.).
 *  3. Hardcoded default constant (e.g., DEFAULT_SYSTEM_PROMPT, temperature = 0.7).
 *
 * Having all config resolution in one place ensures that the agent, tools, and any
 * future modules consistently observe the same effective settings for a room.
 */

import { ChatRoom } from '../db/schema';
import { DEFAULT_SYSTEM_PROMPT } from '../core/prompts';

function parseIntegerEnv(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((rawValue ?? '').trim(), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function parseFloatEnv(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat((rawValue ?? '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBooleanEnv(rawValue: string | undefined, fallback: boolean): boolean {
  if (rawValue === undefined) return fallback;
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

/**
 * Service to manage the dynamic merging of hardcoded/ENV defaults
 * with database-level overrides for a specific chat room.
 */
export class ConfigService {
  /**
   * Returns the fully resolved configuration for a given chat room.
   * If a field in the DB is null, it falls back to the .env variable or hardcoded default.
   */
  static getResolvedConfig(room: ChatRoom) {
    const defaultSystemPrompt = process.env.DEFAULT_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;

    const envContextLimit = parseIntegerEnv(process.env.CONTEXT_MESSAGE_LIMIT, 10);
    const envTemperature = parseFloatEnv(process.env.AI_TEMPERATURE, 0.7);
    const envMaxTokens = parseIntegerEnv(process.env.AI_MAX_TOKENS, 2048);
    const envAutoReplyAll = parseBooleanEnv(process.env.AUTO_REPLY_ALL, false);
    // V7.13: Global summarization toggle. When false, no LLM summarization call is made
    // and only the most recent contextLimit messages are sent to the LLM.
    const envSummarize = parseBooleanEnv(process.env.CONTEXT_SUMMARIZE, true);

    return {
      systemPrompt: room.systemPrompt || defaultSystemPrompt,
      contextLimit: room.contextLimit ?? envContextLimit,
      temperature: room.temperature ?? envTemperature,
      maxTokens: room.maxTokens ?? envMaxTokens,
      allowTools: room.allowTools ?? true, // allow tools by default unless explicitly disabled in DB
      autoReplyAll: room.autoReplyAll ?? envAutoReplyAll,
      // V7.13: Per-room summarization. null in DB → fall back to env default.
      summarize: room.summarize ?? envSummarize,
    };
  }
}
