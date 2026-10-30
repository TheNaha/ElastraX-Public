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
import { ConfigService } from '../utils/ConfigService';
import { readBooleanEnv } from '../config/runtime';
import { logger } from '../utils/logger';
import { levenshtein } from '../utils/similarity';
import { getErrorMessage } from '../utils/errorUtils';
import { t, type Locale } from '../utils/i18n';
import {
  chatRoomsRoomColumns,
  pickPreferredRoomRow,
  resolveRoomIdentity,
  roomIdentityCondition,
  roomKeyBackfill,
} from '../agent/roomKey';

const log = logger.child({ module: 'ConfigTool' });
const CONFIG_KEYS = ['systemPrompt', 'contextLimit', 'temperature', 'maxTokens', 'allowTools', 'autoReplyAll', 'summarize', 'longTermMemory'] as const;
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

function parseIntegerValue(value: string, min: number, max: number, lang: Locale): number {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) throw new Error(t(lang, 'config.parse_integer'));
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) throw new Error(t(lang, 'config.parse_integer'));
  if (parsed < min || parsed > max) throw new Error(t(lang, 'config.parse_range', { min: String(min), max: String(max) }));
  return parsed;
}

function parseFloatValue(value: string, min: number, max: number, lang: Locale): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new Error(t(lang, 'config.parse_float'));
  if (parsed < min || parsed > max) throw new Error(t(lang, 'config.parse_range', { min: String(min), max: String(max) }));
  return parsed;
}

function parseConfigValue(key: ConfigKey, value: string, lang: Locale): ConfigValue {
  switch (key) {
    case 'systemPrompt':
      if (value.length > 20_000) throw new Error(t(lang, 'config.system_prompt_too_long'));
      return value;
    case 'contextLimit':
      return parseIntegerValue(value, 1, 50, lang);
    case 'temperature':
      try {
        return parseFloatValue(value, 0, 2.0, lang);
      } catch {
        throw new Error(t(lang, 'config.invalid_temperature'));
      }
    case 'maxTokens':
      return parseIntegerValue(value, 64, 8192, lang);
    case 'allowTools':
    case 'autoReplyAll':
    case 'summarize':
    case 'longTermMemory': {
      const normalized = value.trim().toLowerCase();
      if (normalized === '1') return true;
      if (normalized === '0') return false;
      if (normalized !== 'true' && normalized !== 'false') throw new Error(t(lang, 'config.must_be_boolean'));
      return readBooleanEnv(normalized, false);
    }
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
            key: { type: 'string', description: 'The config key to read or modify', enum: ['systemPrompt', 'contextLimit', 'temperature', 'maxTokens', 'allowTools', 'autoReplyAll', 'summarize', 'longTermMemory'] },
            value: { type: 'string', description: 'The new value' }
          },
          required: ['action']
        }
      }
    };
  }

  /**
   * Builds a human-readable listing of the room's current configuration values,
   * indicating whether each field is a custom DB override or the global default.
   */
  private buildKeyListing(room: ChatRoom, resolved: ReturnType<typeof ConfigService.getResolvedConfig>, lang: Locale): string {
    const customLabel = t(lang, 'config.value_custom');
    const envDefault = t(lang, 'config.value_default_env');
    const defaultLabel = (val: unknown) => t(lang, 'config.value_default', { value: String(val) });
    return [
      ` • *\`systemPrompt\`*: ${room.systemPrompt ? customLabel : envDefault}`,
      ` • *\`contextLimit\`*: ${room.contextLimit ?? defaultLabel(resolved.contextLimit)}`,
      ` • *\`temperature\`*: ${room.temperature ?? defaultLabel(resolved.temperature)}`,
      ` • *\`maxTokens\`*: ${room.maxTokens ?? defaultLabel(resolved.maxTokens)}`,
      ` • *\`allowTools\`*: ${room.allowTools ?? defaultLabel(resolved.allowTools)}`,
      ` • *\`autoReplyAll\`*: ${room.autoReplyAll ?? defaultLabel(resolved.autoReplyAll)}`,
      ` • *\`summarize\`*: ${room.summarize ?? defaultLabel(resolved.summarize)}`,
      ` • *\`longTermMemory\`*: ${room.longTermMemory ?? defaultLabel(resolved.longTermMemory)}`,
    ].join('\n\n');
  }

  async execute(args: ConfigArgs, ctx: MessageContext): Promise<string> {
    const { action, key, value } = args;
    const lang = (ctx.language ?? 'en') as Locale;
    log.debug({ action, key, chatId: ctx.chatId, senderId: ctx.senderId }, 'Config tool invoked');

    // Room config lookup prefers the canonical room key and falls back to the
    // legacy chat-room id so a pre-migration room row stays editable.
    const roomIdentity = resolveRoomIdentity(ctx);
    const roomColumns = chatRoomsRoomColumns();
    const roomCondition = roomIdentityCondition(roomColumns, roomIdentity);
    const rows = await db.select().from(chatRooms).where(roomCondition);
    const room = pickPreferredRoomRow(rows, roomIdentity.roomKey);
    if (!room) return t(lang, 'config.room_not_found');

    const resolved = ConfigService.getResolvedConfig(room, ctx.isGroup);

    const getSuggestionMessage = (inputKey?: string): string => {
      if (!inputKey) return '';
      let bestMatch = '';
      let bestDist = Infinity;
      for (const validKey of CONFIG_KEYS) {
        const dist = levenshtein(inputKey.toLowerCase(), validKey.toLowerCase());
        if (dist <= 3 && dist < bestDist) {
          bestDist = dist;
          bestMatch = validKey;
        }
      }
      return bestMatch ? t(lang, 'config.suggestion_for', { suggestion: bestMatch }) : '';
    };

    if (action === 'get') {
      log.debug({ chatId: ctx.chatId }, 'Retrieving config for room');
      return `${t(lang, 'config.get_header', { chatId: ctx.chatId })}${this.buildKeyListing(room, resolved, lang)}`;
    }

    if (action === 'reset') {
      if (!isConfigKey(key)) {
        const suggestionStr = getSuggestionMessage(key);
        return `${t(lang, 'config.reset_prompt', { suggestion: suggestionStr })}\n${t(lang, 'config.available_keys')}${this.buildKeyListing(room, resolved, lang)}`;
      }
      const updateData: RoomConfigUpdate = { [key]: null };
      // Dual write: adopt the canonical key on rows the migration has not
      // backfilled yet, so the next lookup resolves through room_key.
      const backfill = roomKeyBackfill(room.roomKey, roomIdentity.roomKey);
      await db.update(chatRooms).set({ ...updateData, ...backfill }).where(roomCondition);
      log.info({ chatId: ctx.chatId, key, resetBy: ctx.senderId }, 'Config key reset to default');
      return t(lang, 'config.reset_success', { key: String(key) });
    }

    if (action === 'set') {
      if (!isConfigKey(key)) {
        const suggestionStr = getSuggestionMessage(key);
        return `${t(lang, 'config.set_prompt', { suggestion: suggestionStr })}\n${t(lang, 'config.available_keys')}${this.buildKeyListing(room, resolved, lang)}`;
      }
      if (value === undefined || value === '') {
        return t(lang, 'config.set_value_missing', { key: String(key) });
      }

      try {
        const parsedValue = parseConfigValue(key, value, lang);
        const updateData = buildConfigUpdate(key, parsedValue);
        const backfill = roomKeyBackfill(room.roomKey, roomIdentity.roomKey);

        await db.update(chatRooms).set({ ...updateData, ...backfill }).where(roomCondition);
        log.info({ chatId: ctx.chatId, key, setBy: ctx.senderId }, 'Config key updated');
        return t(lang, 'config.set_success', { key: String(key) });

      } catch (error: unknown) {
        const message = getErrorMessage(error, 'Unknown validation error.');
        log.warn({ chatId: ctx.chatId, key, err: message }, 'Invalid config value rejected');
        return t(lang, 'config.set_invalid_value', { key: String(key), msg: message });
      }
    }

    return `${t(lang, 'config.usage_help')}${t(lang, 'config.available_keys')}${this.buildKeyListing(room, resolved, lang)}`;
  }
}
