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
 *
 * Permissions required: `admin`
 * Slash command aliases: `/conf`, `/settings`
 */

import { BaseTool } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { db } from '../db';
import { chatRooms } from '../db/schema';
import { eq } from 'drizzle-orm';
import { ConfigService } from '../utils/ConfigService';

export class ConfigTool extends BaseTool {
  readonly name = 'config';
  readonly description = 'Manage dynamic bot configurations for this chat room.';
  readonly aliases = ['conf', 'settings'];
  readonly category = 'Admin';
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
            key: { type: 'string', description: 'The config key to read or modify', enum: ['systemPrompt', 'contextLimit', 'temperature', 'maxTokens', 'allowTools', 'autoReplyAll'] },
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
  private buildKeyListing(room: any, resolved: ReturnType<typeof ConfigService.getResolvedConfig>): string {
    return [
      `  *System Prompt*: ${room.systemPrompt ? '[CUSTOM]' : '[DEFAULT (env)]'}`,
      `  *Context Limit*: ${room.contextLimit ?? `[DEFAULT: ${resolved.contextLimit}]`}`,
      `  *Temperature*: ${room.temperature ?? `[DEFAULT: ${resolved.temperature}]`}`,
      `  *Max Tokens*: ${room.maxTokens ?? `[DEFAULT: ${resolved.maxTokens}]`}`,
      `  *Allow Tools*: ${room.allowTools ?? `[DEFAULT: ${resolved.allowTools}]`}`,
      `  *Auto Reply All*: ${room.autoReplyAll ?? `[DEFAULT: ${resolved.autoReplyAll}]`}`,
    ].join('\n');
  }

  async execute(args: any, ctx: MessageContext): Promise<string> {
    const { action, key, value } = args;

    // Fetch current room
    const room = (await db.select().from(chatRooms).where(eq(chatRooms.id, ctx.chatId)))[0];
    if (!room) return 'Error: Chat room not found in database.';

    const validKeys = ['systemPrompt', 'contextLimit', 'temperature', 'maxTokens', 'allowTools', 'autoReplyAll'];
    const resolved = ConfigService.getResolvedConfig(room);

    if (action === 'get') {
      return `*Current Configuration for ${ctx.chatId}*\n\n${this.buildKeyListing(room, resolved)}`;
    }

    if (action === 'reset') {
      if (!key || !validKeys.includes(key as string)) {
        return `Please provide a valid key to reset to global default.\n\n*Available Keys (current values for this room):*\n${this.buildKeyListing(room, resolved)}`;
      }
      const updateData: any = {};
      updateData[key] = null;
      await db.update(chatRooms).set(updateData).where(eq(chatRooms.id, ctx.chatId));
      return `Configuration \`${key}\` has been reset to its global fallback value.`;
    }

    if (action === 'set') {
      if (!key || !validKeys.includes(key as string)) {
        return `Please provide a valid key to set.\n\n*Available Keys (current values for this room):*\n${this.buildKeyListing(room, resolved)}`;
      }
      if (value === undefined || value === '') {
        return `Please provide a value for ${key}.`;
      }

      const updateData: any = {};
      
      try {
        if (key === 'systemPrompt') {
          if (value.length > 50000) throw new Error('System prompt too long (max 50000 chars).');
          updateData[key] = value;
        } else if (key === 'contextLimit') {
          const parsed = parseInt(value, 10);
          if (isNaN(parsed)) throw new Error('Must be an integer.');
          // Security: Limit context size to prevent DoS (memory exhaustion/token overflow)
          if (parsed < 1 || parsed > 50) throw new Error('Must be between 1 and 50.');
          updateData[key] = parsed;
        } else if (key === 'temperature') {
          const parsed = parseFloat(value);
          if (isNaN(parsed)) throw new Error('Must be a number.');
          // Security: Ensure valid temperature range for AI stability
          if (parsed < 0 || parsed > 2.0) throw new Error('Must be between 0.0 and 2.0.');
          updateData[key] = parsed;
        } else if (key === 'maxTokens') {
          const parsed = parseInt(value, 10);
          if (isNaN(parsed)) throw new Error('Must be an integer.');
          if (parsed < 64 || parsed > 8192) throw new Error('Must be between 64 and 8192.');
          updateData[key] = parsed;
        } else if (key === 'allowTools' || key === 'autoReplyAll') {
          const lower = value.toLowerCase();
          if (lower === 'true' || lower === '1') updateData[key] = true;
          else if (lower === 'false' || lower === '0') updateData[key] = false;
          else throw new Error('Must be true or false.');
        }

        await db.update(chatRooms).set(updateData).where(eq(chatRooms.id, ctx.chatId));
        return `Successfully updated \`${key}\` for this room.`;

      } catch (e: any) {
        return `Invalid value for ${key}: ${e.message}`;
      }
    }

    return `*Config Usage:* /config <get|set|reset> [key] [value]\n\n*Available Keys (current values for this room):*\n${this.buildKeyListing(room, resolved)}`;
  }
}
