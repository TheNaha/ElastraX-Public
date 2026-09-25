import type { ChatRoom } from '../db/schema';
import { getDefaultSystemPrompt } from '../core/prompts';
import {
  getAIRequestConfig,
  readBooleanEnv,
  readFloatEnv,
  readIntegerEnv,
  readStringEnv,
} from '../config/runtime';

export type ResolvedRoomConfig = {
  systemPrompt: string;
  contextLimit: number;
  temperature: number;
  maxTokens: number;
  allowTools: boolean;
  autoReplyAll: boolean;
  summarize: boolean;
  longTermMemory: boolean;
};

export class ConfigService {
  static getDefaults(isGroup: boolean = false): ResolvedRoomConfig {
    return {
      systemPrompt: readStringEnv(process.env.DEFAULT_SYSTEM_PROMPT, getDefaultSystemPrompt()),
      contextLimit: readIntegerEnv(process.env.CONTEXT_MESSAGE_LIMIT, 10, { min: -1, max: 10_000 }),
      temperature: readFloatEnv(process.env.AI_TEMPERATURE, 0.7, { min: 0, max: 2 }),
      maxTokens: getAIRequestConfig().maxTokens,
      allowTools: readBooleanEnv(process.env.ALLOW_TOOLS, true),
      autoReplyAll: readBooleanEnv(process.env.AUTO_REPLY_ALL, false),
      summarize: readBooleanEnv(process.env.CONTEXT_SUMMARIZE, true),
      longTermMemory: readBooleanEnv(process.env.LONG_TERM_MEMORY, !isGroup),
    };
  }

  static getResolvedConfig(room: Partial<ChatRoom>, isGroup: boolean = false): ResolvedRoomConfig {
    const defaults = this.getDefaults(isGroup);
    const contextLimit = room.contextLimit === 0 ? defaults.contextLimit : room.contextLimit;
    const maxTokens = room.maxTokens === 0 ? defaults.maxTokens : room.maxTokens;
    const temperature = room.temperature ?? defaults.temperature;

    return {
      systemPrompt: room.systemPrompt?.trim() || defaults.systemPrompt,
      contextLimit: contextLimit !== undefined && contextLimit !== null
        ? Math.max(-1, Math.min(10_000, Math.trunc(contextLimit)))
        : defaults.contextLimit,
      temperature: temperature !== undefined && temperature !== null
        ? Math.max(0, Math.min(2, temperature))
        : defaults.temperature,
      maxTokens: maxTokens !== undefined && maxTokens !== null
        ? Math.max(1, Math.min(1_000_000, Math.trunc(maxTokens)))
        : defaults.maxTokens,
      allowTools: room.allowTools ?? defaults.allowTools,
      autoReplyAll: room.autoReplyAll ?? defaults.autoReplyAll,
      summarize: room.summarize ?? defaults.summarize,
      longTermMemory: room.longTermMemory ?? defaults.longTermMemory,
    };
  }
}
