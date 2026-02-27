/**
 * @file src/tools/StatsTool.ts
 * @description Chat room usage statistics tool.
 *
 * Queries the messages table to return summary stats for the current chat room:
 * total message count, bot vs human split, room age, and the most active user.
 *
 * Works both conversationally ("show me this room's stats", "how many messages have been sent?")
 * and via slash command (/stats).
 *
 * Slash command aliases: /stats, /statistics
 */

import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { db } from '../db';
import { messages } from '../db/schema';
import { eq, count, min, sql, desc, and } from 'drizzle-orm';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';

export class StatsTool extends BaseTool {
  readonly name = 'room_stats';
  readonly description = 'Show usage statistics for the current chat room: total messages, bot replies, most active user, and room age. Use when the user asks about room stats, message counts, or activity.';
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

  async execute(_args: Record<string, any>, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';

    try {
      const summaryRows = db
        .select({
          total: count(messages.id),
          botReplies: sql<number>`sum(case when ${messages.role} = 'assistant' then 1 else 0 end)`,
          oldest: min(messages.created_at),
        })
        .from(messages)
        .where(eq(messages.chatRoomId, ctx.chatId))
        .all();

      const summary = summaryRows[0];
      const total = summary?.total ?? 0;

      if (total === 0) {
        return t(lang, 'stats.no_data');
      }

      const botReplies = Number(summary?.botReplies ?? 0);
      const humanMessages = total - botReplies;

      const oldest = summary?.oldest ?? new Date();
      const since = oldest.toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
      });

      let topUser = '—';
      let topCount = 0;
      const topRows = db
        .select({
          senderName: messages.senderName,
          msgCount: count(messages.id),
        })
        .from(messages)
        .where(and(eq(messages.chatRoomId, ctx.chatId), eq(messages.role, 'user')))
        .groupBy(messages.senderId, messages.senderName)
        .orderBy(desc(sql`count(${messages.id})`))
        .limit(1)
        .all();

      if (topRows[0]) {
        topUser = topRows[0].senderName;
        topCount = topRows[0].msgCount;
      }

      return t(lang, 'stats.response', {
        total: String(total),
        botReplies: String(botReplies),
        humanMessages: String(humanMessages),
        since,
        topUser,
        topCount: String(topCount),
      });
    } catch (err: any) {
      logger.error({ err }, '[StatsTool] Failed to fetch stats');
      return `❌ Failed to retrieve stats: ${err.message}`;
    }
  }
}
