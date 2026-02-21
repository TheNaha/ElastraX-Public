import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { db } from '../db';
import { chatRooms } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { t } from '../utils/i18n';

export class LanguageTool extends BaseTool {
  readonly name = 'language';
  readonly description = 'Change the bot language for the current chat room (supports "en" for English, "id" for Indonesian).';
  readonly aliases = ['lang', 'setlanguage', 'setlang'];
  readonly category = 'settings';
  readonly permissions = 'user'; // Any user can change language for now

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            lang_code: {
              type: 'string',
              description: 'The language code to set (e.g., "en" or "id").',
              enum: ['en', 'id']
            },
          },
          required: ['lang_code'],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: MessageContext): Promise<string> {
    const { lang_code } = args;

    if (!lang_code || (lang_code !== 'en' && lang_code !== 'id')) {
      return t(ctx.language, 'language.invalid');
    }

    try {
      await ctx.react?.('⏳');
      // Update the database for the active chat room
      await db.update(chatRooms)
        .set({ language: lang_code })
        .where(eq(chatRooms.id, ctx.chatId));

      const key = lang_code === 'id' ? 'language.success_id' : 'language.success_en';
      return t(lang_code, key);
    } catch (e: any) {
      logger.error(e, 'Failed to update language');
      return t(ctx.language, 'language.error', { msg: e.message });
    }
  }
}
