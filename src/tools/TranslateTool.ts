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
import { ModelRouter } from '../utils/ModelRouter';

// Module-level router reuse
let router: ModelRouter | null = null;
function getRouter(): ModelRouter {
  if (!router) router = new ModelRouter();
  return router;
}

export class TranslateTool extends BaseTool {
  readonly name = 'translate';
  readonly description = 'Translate text from one language to another. If the user replies to a message, translate that quoted message. Otherwise translate the provided text. Auto-detect the source language.';
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
            target_language: {
              type: 'string',
              description: 'The language to translate into (e.g., "English", "Indonesian", "Spanish", "French", "Japanese"). Use the full language name.',
            },
            text: {
              type: 'string',
              description: 'The text to translate. Leave empty to use the quoted/replied-to message.',
            },
          },
          required: ['target_language'],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    const targetLang = String(args.target_language || 'English');

    // Resolve source text: explicit arg > quoted message > error
    let sourceText = args.text ? String(args.text) : '';
    if (!sourceText && ctx.quoted?.body) {
      sourceText = ctx.quoted.body;
    }

    if (!sourceText.trim()) {
      return t(lang, 'translate.no_text');
    }

    try {
      await ctx.react?.('🌐');

      const aiMsg = await getRouter().chatCompletion([
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
      logger.error({ err }, '[TranslateTool] Translation failed');
      return t(lang, 'translate.error', { msg: err.message });
    }
  }
}
