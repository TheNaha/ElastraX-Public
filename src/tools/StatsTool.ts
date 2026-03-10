import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { db } from '../db';
import { messages } from '../db/schema';
import { eq, count, min, sql, desc, and } from 'drizzle-orm';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';

const log = logger.child({ module: 'StatsTool' });

export class StatsTool extends BaseTool<ToolArgs> {
  readonly name = 'room_stats';
  readonly description = 'Show chat room usage statistics: message counts, most active user, room age.';
  readonly aliases = ['stats', 'statistics'];
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
          properties: {},
          required: [],
        },
      },
    };
  }

  async execute(_args: ToolArgs, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    log.debug({ chatId: ctx.chatId }, 'Fetching room stats');

    try {
      const summary = db
        .select({
          total: count(messages.id),
          botReplies: sql<number>`sum(case when ${messages.role} = 'assistant' then 1 else 0 end)`,
          oldest: min(messages.created_at),
        })
        .from(messages)
        .where(eq(messages.chatRoomId, ctx.chatId))
        .all()[0];

      const total = summary?.total ?? 0;
      if (total === 0) {
        return t(lang, 'stats.no_data');
      }

      const botReplies = Number(summary?.botReplies ?? 0);
      const humanMessages = total - botReplies;
      const oldest = summary?.oldest ?? new Date();
      const since = oldest.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });

      let topUser = '-';
      let topCount = 0;
      const topRow = db
        .select({
          senderName: messages.senderName,
          msgCount: count(messages.id),
        })
        .from(messages)
        .where(and(eq(messages.chatRoomId, ctx.chatId), eq(messages.role, 'user')))
        .groupBy(messages.senderId, messages.senderName)
        .orderBy(desc(sql`count(${messages.id})`))
        .limit(1)
        .all()[0];

      if (topRow) {
        topUser = topRow.senderName;
        topCount = topRow.msgCount;
      }

      return t(lang, 'stats.response', {
        total: String(total),
        botReplies: String(botReplies),
        humanMessages: String(humanMessages),
        since,
        topUser,
        topCount: String(topCount),
      });
    } catch (error: unknown) {
      log.error({ err: error, chatId: ctx.chatId }, 'Failed to fetch stats');
      return `Failed to retrieve stats: ${getErrorMessage(error)}`;
    }
  }
}
