/**
 * @file src/tools/TranslateTool.ts
 * @description Language translation tool powered by the configured LLM.
 *
 * Translates text using the same LLM already powering the bot — no extra API
 * key or dependency needed. The LLM is instructed to return only the translated
 * text, nothing else.
 *
 * If the user replies to a message, the quoted message body is used as the
 * source text (allowing translate-by-reply). If text is directly provided,
 * that takes priority.
 *
 * Works conversationally ("translate this to Spanish") and via slash command:
 *   /translate [target_lang] [optional: text]  — or reply to a message.
 *
 * Slash command aliases: /translate, /tr
 */

import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { getModelRouter } from '../utils/ModelRouter';
import { ParameterValidator } from '../utils/ParameterValidator';

const log = logger.child({ module: 'TranslateTool' });

const LANGUAGE_MAP: Record<string, string> = {
  'en': 'English',
  'english': 'English',
  'id': 'Indonesian',
  'indonesian': 'Indonesian',
  'indonesia': 'Indonesian',
  'es': 'Spanish',
  'spanish': 'Spanish',
  'fr': 'French',
  'french': 'French',
  'de': 'German',
  'german': 'German',
  'ja': 'Japanese',
  'japanese': 'Japanese',
  'jp': 'Japanese',
  'ko': 'Korean',
  'korean': 'Korean',
  'kr': 'Korean',
  'zh': 'Chinese',
  'chinese': 'Chinese',
  'cn': 'Chinese',
  'ru': 'Russian',
  'russian': 'Russian',
  'pt': 'Portuguese',
  'portuguese': 'Portuguese',
  'br': 'Portuguese',
  'ar': 'Arabic',
  'arabic': 'Arabic',
  'it': 'Italian',
  'italian': 'Italian',
  'nl': 'Dutch',
  'dutch': 'Dutch',
  'tr': 'Turkish',
  'turkish': 'Turkish',
  'th': 'Thai',
  'thai': 'Thai',
  'vi': 'Vietnamese',
  'vietnamese': 'Vietnamese',
  'ms': 'Malay',
  'malay': 'Malay',
  'my': 'Malay',
};

export class TranslateTool extends BaseTool {
  readonly name = 'translate';
  readonly description = 'Translate text. If the first word is a language (e.g., "id", "Spanish"), translates to that language. Otherwise, translates to the room\'s default language (English or Indonesian). If no text is provided, translates the quoted message.';
  readonly aliases = ['translate', 'tr'];
  readonly category = 'utility';
  readonly permissions = 'user';

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The target language (optional) followed by text, OR just the text to translate.',
            },
          },
          required: [],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    const query = args.query ? String(args.query).trim() : '';

    // Determine default target language based on room language
    let targetLang = lang === 'id' ? 'Indonesian' : 'English';
    let sourceText = '';

    const tokens = ParameterValidator.parseCommandString(query);

    if (tokens.length > 0) {
      const firstTokenLower = tokens[0].toLowerCase();

      // Security: Validate the language token safely to prevent prototype pollution
      if (Object.prototype.hasOwnProperty.call(LANGUAGE_MAP, firstTokenLower)) {
        // First token is a language -> Use it
        targetLang = LANGUAGE_MAP[firstTokenLower];
        // The rest is the source text
        sourceText = tokens.slice(1).join(' ');
      } else {
        // First token is NOT a language -> Treat whole query as text
        sourceText = query;
      }
    }

    // If no text provided (or it was just the language code), check for quoted message
    if (!sourceText && ctx.quoted) {
      sourceText = ctx.quoted.text || ctx.quoted.body;
    }

    if (!sourceText.trim()) {
      return t(lang, 'translate.no_text');
    }

    try {
      await ctx.react?.('🌐');

      log.debug({ targetLang, sourceLength: sourceText.length, chatId: ctx.chatId }, 'Translation requested');

      const aiMsg = await getModelRouter().chatCompletion([
        {
          role: 'system',
          content: `You are a professional translator. Translate the following text to ${targetLang}. Output ONLY the translated text. Do NOT add explanations, notes, or quotes around the result.`,
        },
        {
          role: 'user',
          content: sourceText,
        },
      ], undefined, 0.3);

      const translated = typeof aiMsg?.content === 'string' ? aiMsg.content.trim() : '';
      if (!translated) throw new Error('Empty translation returned.');

      return t(lang, 'translate.success', {
        from: 'auto',
        to: targetLang,
        result: translated,
      });
    } catch (err: any) {
      log.error({ err, targetLang, chatId: ctx.chatId }, 'Translation failed');
      return t(lang, 'translate.error', { msg: err.message });
    }
  }
}
