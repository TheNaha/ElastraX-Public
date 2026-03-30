/**
 * @file src/tools/ConfigTool.ts
 * @description Dynamic per-room bot configuration tool.
 *
 * Allows group/chat admins to inspect and override the bot's behaviour for a
 * specific chat room without restarting the service.  All overrides are stored
 * in the `chat_rooms` table; a `null` value in the DB means "use the global
 * default" (see `ConfigService.getResolvedConfig` for the fallback chain).
 *
 * Supported actions:
 *  - `get`   — Show the current effective configuration (DB override or global default).
 *  - `set`   — Update a specific key for this room with input validation.
 *  - `reset` — Clear a key's override so it reverts to the global default.
 *
 * Configurable keys:
 *  | Key            | Type    | Description                                               |
 *  |----------------|---------|-----------------------------------------------------------|
 *  | systemPrompt   | string  | Custom LLM system prompt (max 50,000 chars)               |
 *  | contextLimit   | integer | Max messages in the context window (1–50)                 |
 *  | temperature    | float   | LLM sampling temperature (0.0–2.0)                        |
 *  | allowTools     | boolean | Enable/disable LLM function-calling for this room         |
 *  | autoReplyAll   | boolean | Reply to every group message without requiring a mention  |
 *  | summarize      | boolean | Compress old chat history into a rolling summary (V7.13)  |
 *
 * Permissions required: `admin`
 * Slash command aliases: `/conf`, `/settings`
 */

import { BaseTool } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { db } from '../db';
import { chatRooms, type ChatRoom } from '../db/schema';
import { eq } from 'drizzle-orm';
import { ConfigService } from '../utils/ConfigService';
import { logger } from '../utils/logger';
import { levenshtein } from '../utils/similarity';

const log = logger.child({ module: 'ConfigTool' });
const CONFIG_KEYS = ['systemPrompt', 'contextLimit', 'temperature', 'maxTokens', 'allowTools', 'autoReplyAll', 'summarize'] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];
type RoomConfigUpdate = Partial<Pick<ChatRoom, ConfigKey>>;
type ConfigValue = Exclude<ChatRoom[ConfigKey], null | undefined>;
type ConfigArgs = {
  action?: string;
  key?: string;
  value?: string;
};

function isConfigKey(value: string | undefined): value is ConfigKey {
  return value !== undefined && CONFIG_KEYS.includes(value as ConfigKey);
}

function parseBooleanValue(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error('Must be true or false.');
}

function parseIntegerValue(value: string, min: number, max: number): number {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error('Must be an integer.');
  if (parsed < min || parsed > max) throw new Error(`Must be between ${min} and ${max}.`);
  return parsed;
}

function parseFloatValue(value: string, min: number, max: number): number {
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) throw new Error('Must be a number.');
  if (parsed < min || parsed > max) throw new Error(`Must be between ${min} and ${max}.`);
  return parsed;
}

function parseConfigValue(key: ConfigKey, value: string): ConfigValue {
  switch (key) {
    case 'systemPrompt':
      if (value.length > 50000) throw new Error('System prompt too long (max 50000 chars).');
      return value;
    case 'contextLimit':
      return parseIntegerValue(value, 1, 50);
    case 'temperature':
      try {
        return parseFloatValue(value, 0, 2.0);
      } catch (error) {
        if (error instanceof Error && error.message === 'Must be between 0 and 2.') {
          throw new Error('Must be between 0.0 and 2.0.');
        }
        throw error;
      }
    case 'maxTokens':
      return parseIntegerValue(value, 64, 8192);
    case 'allowTools':
    case 'autoReplyAll':
    case 'summarize':
      return parseBooleanValue(value);
  }
}

function buildConfigUpdate<K extends ConfigKey>(key: K, value: Exclude<ChatRoom[K], null | undefined>): Pick<ChatRoom, K> {
  return { [key]: value } as unknown as Pick<ChatRoom, K>;
}

export class ConfigTool extends BaseTool {
  readonly name = 'config';
  readonly description = 'Manage dynamic bot configurations for this chat room.';
  readonly aliases = ['conf', 'settings'];
  readonly category = 'admin';
  readonly permissions: 'admin' | 'owner' | 'user' = 'admin';
  readonly groupOnly = false;

  get definition() {
    return {
      type: 'function' as const,
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object' as const,
          properties: {
            action: { type: 'string', description: 'get, set, or reset', enum: ['get', 'set', 'reset'] },
            key: { type: 'string', description: 'The config key to read or modify', enum: ['systemPrompt', 'contextLimit', 'temperature', 'maxTokens', 'allowTools', 'autoReplyAll', 'summarize'] },
            value: { type: 'string', description: 'The new value' }
          },
          required: ['action']
        }
      }
    };
  }

  constructor() {
    super();
  }

  /**
   * Builds a human-readable listing of the room's current configuration values,
   * indicating whether each field is a custom DB override or the global default.
   */
  private buildKeyListing(room: ChatRoom, resolved: ReturnType<typeof ConfigService.getResolvedConfig>): string {
    return [
      ` • *\`systemPrompt\`*: ${room.systemPrompt ? '(Custom)' : '(Default: env)'}`,
      ` • *\`contextLimit\`*: ${room.contextLimit ?? `(Default: ${resolved.contextLimit})`}`,
      ` • *\`temperature\`*: ${room.temperature ?? `(Default: ${resolved.temperature})`}`,
      ` • *\`maxTokens\`*: ${room.maxTokens ?? `(Default: ${resolved.maxTokens})`}`,
      ` • *\`allowTools\`*: ${room.allowTools ?? `(Default: ${resolved.allowTools})`}`,
      ` • *\`autoReplyAll\`*: ${room.autoReplyAll ?? `(Default: ${resolved.autoReplyAll})`}`,
      ` • *\`summarize\`*: ${room.summarize ?? `(Default: ${resolved.summarize})`}`,
    ].join('\n\n');
  }

  async execute(args: ConfigArgs, ctx: MessageContext): Promise<string> {
    const { action, key, value } = args;
    log.debug({ action, key, chatId: ctx.chatId, senderId: ctx.senderId }, 'Config tool invoked');

    // Fetch current room
    const room = (await db.select().from(chatRooms).where(eq(chatRooms.id, ctx.chatId)))[0];
    if (!room) return 'Error: Chat room not found in database.';

    const resolved = ConfigService.getResolvedConfig(room);

    const getSuggestionMessage = (inputKey?: string): string => {
      if (!inputKey) return '\n';
      let bestMatch = '';
      let bestDist = Infinity;
      for (const validKey of CONFIG_KEYS) {
        const dist = levenshtein(inputKey.toLowerCase(), validKey.toLowerCase());
        if (dist <= 3 && dist < bestDist) {
          bestDist = dist;
          bestMatch = validKey;
        }
      }
      return bestMatch ? `\n\nDid you mean \`${bestMatch}\`?\n` : '\n';
    };

    if (action === 'get') {
      log.debug({ chatId: ctx.chatId }, 'Retrieving config for room');
      return `*Current Configuration for ${ctx.chatId}*\n\n${this.buildKeyListing(room, resolved)}`;
    }

    if (action === 'reset') {
      if (!isConfigKey(key)) {
        const suggestionStr = getSuggestionMessage(key);
        return `Please provide a valid key to reset to global default.${suggestionStr}\n*Available Keys (current values for this room):*\n\n${this.buildKeyListing(room, resolved)}`;
      }
      const updateData: RoomConfigUpdate = { [key]: null };
      await db.update(chatRooms).set(updateData).where(eq(chatRooms.id, ctx.chatId));
      log.info({ chatId: ctx.chatId, key, resetBy: ctx.senderId }, 'Config key reset to default');
      return `Configuration \`${key}\` has been reset to its global fallback value.`;
    }

    if (action === 'set') {
      if (!isConfigKey(key)) {
        const suggestionStr = getSuggestionMessage(key);
        return `Please provide a valid key to set.${suggestionStr}\n*Available Keys (current values for this room):*\n\n${this.buildKeyListing(room, resolved)}`;
      }
      if (value === undefined || value === '') {
        return `Please provide a value for ${key}.`;
      }

      try {
        const parsedValue = parseConfigValue(key, value);
        const updateData = buildConfigUpdate(key, parsedValue);

        await db.update(chatRooms).set(updateData).where(eq(chatRooms.id, ctx.chatId));
        log.info({ chatId: ctx.chatId, key, value: parsedValue, setBy: ctx.senderId }, 'Config key updated');
        return `Successfully updated \`${key}\` for this room.`;

      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown validation error.';
        log.warn({ chatId: ctx.chatId, key, value, err: message }, 'Invalid config value rejected');
        return `Invalid value for ${key}: ${message}`;
      }
    }

    return `*Config Usage:* \`/config <get|set|reset> [key] [value]\`\n\n*Available Keys (current values for this room):*\n\n${this.buildKeyListing(room, resolved)}`;
  }
}
