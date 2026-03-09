/**
 * @file src/tools/LanguageTool.ts
 * @description Per-room language configuration tool.
 *
 * Updates the `language` column of the active chat room in the database.
 * The selected language affects:
 *  - All system messages and error strings (via the `t()` i18n helper).
 *  - The `{{LANGUAGE}}` placeholder in the LLM system prompt, which instructs
 *    the model to reply in the chosen language.
 *
 * Supported language codes:
 *  - `en` — English (default)
 *  - `id` — Indonesian (Bahasa Indonesia)
 *
 * Permissions required: `user` (any participant can change the room language).
 * Slash command aliases: `/lang`, `/setlanguage`, `/setlang`
 */

import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { db } from '../db';
import { chatRooms } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { t } from '../utils/i18n';
import { getErrorMessage } from '../utils/errorUtils';

const log = logger.child({ module: 'LanguageTool' });
type LanguageToolArgs = ToolArgs & {
  lang_code?: 'en' | 'id';
};

export class LanguageTool extends BaseTool<LanguageToolArgs> {
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

  async execute(args: LanguageToolArgs, ctx: MessageContext): Promise<string> {
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

      log.info({ chatId: ctx.chatId, lang_code, changedBy: ctx.senderId }, 'Room language updated');

      const key = lang_code === 'id' ? 'language.success_id' : 'language.success_en';
      return t(lang_code, key);
    } catch (error: unknown) {
      log.error({ err: error, chatId: ctx.chatId, lang_code }, 'Failed to update language');
      return t(ctx.language, 'language.error', { msg: getErrorMessage(error) });
    }
  }
}
