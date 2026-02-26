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
import { eq, count, min, sql } from 'drizzle-orm';
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
      const allMessages = db
        .select({
          role: messages.role,
          senderName: messages.senderName,
          senderId: messages.senderId,
          created_at: messages.created_at,
        })
        .from(messages)
        .where(eq(messages.chatRoomId, ctx.chatId))
        .all();

      if (allMessages.length === 0) {
        return t(lang, 'stats.no_data');
      }

      const total = allMessages.length;
      const botReplies = allMessages.filter(m => m.role === 'assistant').length;
      const humanMessages = total - botReplies;

      // Find the room's oldest message timestamp
      const oldest = allMessages.reduce((min, m) =>
        m.created_at < min ? m.created_at : min,
        allMessages[0].created_at,
      );
      const since = oldest.toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
      });

      // Count per-user message frequency (human messages only)
      const userCounts = new Map<string, { name: string; count: number }>();
      for (const m of allMessages) {
        if (m.role !== 'user') continue;
        const existing = userCounts.get(m.senderId);
        if (existing) {
          existing.count++;
        } else {
          userCounts.set(m.senderId, { name: m.senderName, count: 1 });
        }
      }

      let topUser = '—';
      let topCount = 0;
      for (const { name, count } of userCounts.values()) {
        if (count > topCount) {
          topCount = count;
          topUser = name;
        }
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
