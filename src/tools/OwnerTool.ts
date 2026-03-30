/**
 * @file src/tools/OwnerTool.ts
 * @description Owner-only bot administration tool.
 *
 * Provides privileged commands accessible only to the bot owner:
 *  - `broadcast` — Send a message to all known rooms on the current platform.
 *  - `leave`     — Make the bot leave the current group chat.
 *  - `system_info` — Show bot memory, uptime, and room count.
 *
 * Both slash-command and conversational invocation are supported:
 *   Slash:          /broadcast Hello everyone!
 *   Conversational: "broadcast a maintenance notice to all groups"
 *
 * Slash command aliases: /owner, /broadcast, /leave, /botleave
 */

import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { db } from '../db';
import { chatRooms } from '../db/schema';
import { eq } from 'drizzle-orm';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import type { ModelTier } from '../types/ai';
import { getErrorMessage } from '../utils/errorUtils';

const log = logger.child({ module: 'OwnerTool' });
type OwnerArgs = ToolArgs & {
  action?: 'broadcast' | 'leave' | 'system_info' | string;
  message?: string;
};

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

export class OwnerTool extends BaseTool<OwnerArgs> {
  readonly name = 'owner_admin';
  readonly description = 'Owner-only bot administration: broadcast messages to all rooms, leave a group, or get system info.';
  readonly aliases = ['owner', 'broadcast', 'leave', 'botleave'];
  readonly category = 'owner';
  readonly permissions = 'owner';
  readonly modelTier: ModelTier = 'fast';

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['broadcast', 'leave', 'system_info'],
              description: '"broadcast" to send a message to all rooms, "leave" to leave the current group, "system_info" for bot stats.',
            },
            message: {
              type: 'string',
              description: 'The broadcast message text. Required for action=broadcast.',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  async execute(args: OwnerArgs, ctx: MessageContext): Promise<string> {
    const { action, message } = args;
    const lang = ctx.language ?? 'en';
    const cmd = String(args.__command || '').toLowerCase();

    log.info({ action, cmd, senderId: ctx.senderId }, 'Owner action requested');

    // Slash command routing: /broadcast <msg>, /leave, /botleave
    if (cmd === 'broadcast' && action !== 'leave' && action !== 'system_info') {
      const broadcastMsg = [action, message].filter(Boolean).join(' ').trim();
      return this.handleBroadcast(broadcastMsg || undefined, ctx, lang);
    }
    if ((cmd === 'leave' || cmd === 'botleave') && !['broadcast', 'system_info'].includes(String(action))) {
      return this.handleLeave(ctx, lang);
    }

    switch (action) {
      case 'broadcast':
        return this.handleBroadcast(message, ctx, lang);
      case 'leave':
        return this.handleLeave(ctx, lang);
      case 'system_info':
        return this.handleSystemInfo(ctx);
      default:
        return t(lang, 'owner.usage');
    }
  }

  private async handleBroadcast(message: string | undefined, ctx: MessageContext, lang: string): Promise<string> {
    if (!message?.trim()) {
      return t(lang, 'owner.broadcast_no_message');
    }

    const rooms = db.select({ id: chatRooms.id, platform: chatRooms.platform })
      .from(chatRooms)
      .where(eq(chatRooms.platform, ctx.platform))
      .all();

    if (rooms.length === 0) {
      return t(lang, 'owner.broadcast_no_rooms');
    }

    let sent = 0;
    let failed = 0;
    const broadcastText = `📢 *Broadcast from Bot Owner:*\n\n${message}`;

    log.info({ roomCount: rooms.length, platform: ctx.platform }, 'Broadcast initiated');

    for (const room of rooms) {
      if (room.id === ctx.chatId) continue;
      try {
        await ctx.forwardMessage?.(room.id, broadcastText);
        sent++;
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (err) {
        failed++;
        log.warn({ err, roomId: room.id }, 'Broadcast failed for room');
      }
    }

    return t(lang, 'owner.broadcast_done', {
      sent: String(sent),
      failed: String(failed),
      total: String(rooms.length - 1),
    });
  }

  private async handleLeave(ctx: MessageContext, lang: string): Promise<string> {
    if (!ctx.isGroup) {
      return t(lang, 'owner.leave_not_group');
    }

    try {
      log.info({ chatId: ctx.chatId, requestedBy: ctx.senderId }, 'Bot leaving group');
      await ctx.reply(t(lang, 'owner.leave_goodbye'));
      if (ctx.leaveGroup) {
        await ctx.leaveGroup();
      } else {
        return t(lang, 'owner.leave_not_supported');
      }
      return '';
    } catch (error: unknown) {
      log.error({ err: error, chatId: ctx.chatId }, 'Failed to leave group');
      return t(lang, 'owner.leave_error', { msg: getErrorMessage(error) });
    }
  }

  private async handleSystemInfo(_ctx: MessageContext): Promise<string> {
    const roomCount = db.select({ id: chatRooms.id }).from(chatRooms).all().length;
    const memUsage = process.memoryUsage();
    return [
      '🤖 *ElastraX System Info*',
      ` • ⬆️ Uptime: *${formatUptime(process.uptime())}*`,
      ` • 💬 Total Rooms: *${roomCount}*`,
      ` • 🧠 Memory: *${Math.round(memUsage.heapUsed / 1024 / 1024)}MB* / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      ` • 🏗️ Runtime: *Bun ${process.versions.bun || 'unknown'}*`,
    ].join('\n\n');
  }
}

