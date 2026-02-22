import { BaseTool } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { db } from '../db';
import { chatRooms } from '../db/schema';
import { eq } from 'drizzle-orm';
import { ConfigService } from '../utils/ConfigService';

export class ConfigTool extends BaseTool {
  name = 'config';
  description = 'Manage dynamic bot configurations for this chat room.';
  aliases = ['conf', 'settings'];
  category = 'Admin';
  permissions: 'admin' | 'owner' | 'user' = 'admin';
  groupOnly = false;

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
            key: { type: 'string', description: 'The config key to read or modify', enum: ['systemPrompt', 'contextLimit', 'temperature', 'allowTools', 'autoReplyAll'] },
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

  private buildKeyListing(room: any, resolved: ReturnType<typeof ConfigService.getResolvedConfig>): string {
    return [
      `  *System Prompt*: ${room.systemPrompt ? '[CUSTOM]' : '[DEFAULT (env)]'}`,
      `  *Context Limit*: ${room.contextLimit ?? `[DEFAULT: ${resolved.contextLimit}]`}`,
      `  *Temperature*: ${room.temperature ?? `[DEFAULT: ${resolved.temperature}]`}`,
      `  *Allow Tools*: ${room.allowTools ?? `[DEFAULT: ${resolved.allowTools}]`}`,
      `  *Auto Reply All*: ${room.autoReplyAll ?? `[DEFAULT: ${resolved.autoReplyAll}]`}`,
    ].join('\n');
  }

  async execute(args: any, ctx: MessageContext): Promise<string> {
    const { action, key, value } = args;

    // Fetch current room
    const room = (await db.select().from(chatRooms).where(eq(chatRooms.id, ctx.chatId)))[0];
    if (!room) return 'Error: Chat room not found in database.';

    const validKeys = ['systemPrompt', 'contextLimit', 'temperature', 'allowTools', 'autoReplyAll'];
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
          updateData[key] = value;
        } else if (key === 'contextLimit') {
          const parsed = parseInt(value, 10);
          if (isNaN(parsed)) throw new Error('Must be an integer.');
          updateData[key] = parsed;
        } else if (key === 'temperature') {
          const parsed = parseFloat(value);
          if (isNaN(parsed)) throw new Error('Must be a number.');
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
