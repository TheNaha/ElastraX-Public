import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { db } from '../db';
import { chatRooms } from '../db/schema';
import { eq } from 'drizzle-orm';
import { t } from '../utils/i18n';
import { getErrorMessage } from '../utils/errorUtils';
import { getModelRouter } from '../utils/ModelRouter';
import { summarizeRoom } from '../utils/DigestService';

/** Injectable LLM callback (tests override this). */
export const digestToolDeps: { callLLM?: (prompt: string) => Promise<string> } = {};

async function defaultCallLLM(prompt: string): Promise<string> {
  const msg = await getModelRouter().chatCompletion([{ role: 'user', content: prompt }], undefined, 0.2);
  return typeof msg.content === 'string' ? msg.content : '';
}

const MIN_HOURS = 1;
const MAX_HOURS = 168;

export class DigestTool extends BaseTool {
  readonly name = 'digest';
  readonly description = 'Summarize recent conversation history for this chat over a given number of hours (default 24, max 168).';
  readonly aliases = ['ringkasan'];
  readonly category = 'utility';
  readonly permissions = 'user';

  override readonly triggerPatterns = [/\b(digest|recap|ringkasan)\b/i];

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            hours: { type: 'number', description: `How many hours of history to summarize (${MIN_HOURS}-${MAX_HOURS}, default 24)` },
          },
          required: [],
        },
      },
    };
  }

  async execute(args: { hours?: number | string }, ctx: MessageContext): Promise<string> {
    const parsed = typeof args.hours === 'string' ? parseFloat(args.hours) : args.hours;
    const hours = Number.isFinite(parsed)
      ? Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.floor(parsed!)))
      : 24;

    const lang = ctx.language === 'id' ? 'id' : 'en';

    try {
      const room = db.select({ language: chatRooms.language })
        .from(chatRooms)
        .where(eq(chatRooms.id, ctx.chatId))
        .all()[0];
      const roomLang = room?.language ?? ctx.language;

      const result = await summarizeRoom(ctx.chatId, {
        hours,
        maxMessages: 500,
        lang: roomLang,
        deps: { callLLM: digestToolDeps.callLLM ?? defaultCallLLM },
      });

      if (!result) return t(lang, 'digest.no_messages', { hours: String(hours) });
      return `${t(lang, 'digest.header', { hours: String(hours) })}\n\n${result.text}`;
    } catch (error: unknown) {
      return `${t(lang, 'digest.failed')} (${getErrorMessage(error)})`;
    }
  }
}
