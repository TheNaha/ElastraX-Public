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
import { count, eq } from 'drizzle-orm';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import type { ModelTier } from '../types/ai';
import { isSameRoom, roomRemoteId } from '../agent/roomKey';
import { existsSync, type Dirent } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { dirname, resolve as pathResolve, relative as pathRelative, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_ROOT_ENV = 'LOG_ROOT';
const LOG_ROOT_FALLBACK_NODE = pathResolve(__dirname, '..', '..', 'logs');
const LOG_ROOT_FALLBACK_SYSTEM = '/var/log/elastrax';
const LOG_ROOT_FALLBACK_HOME = (home: string) => pathResolve(home, '.local', 'share', 'elastrax', 'logs');

function logRoot(): string {
  if (process.env[LOG_ROOT_ENV]) return process.env[LOG_ROOT_ENV]!;
  if (existsSync(LOG_ROOT_FALLBACK_NODE)) return LOG_ROOT_FALLBACK_NODE;
  if (existsSync(LOG_ROOT_FALLBACK_SYSTEM)) return LOG_ROOT_FALLBACK_SYSTEM;
  return process.env.HOME
    ? LOG_ROOT_FALLBACK_HOME(process.env.HOME)
    : '/tmp/elastrax-logs';
}

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
  readonly description = 'Owner-only bot administration: broadcast messages to all rooms, leave a group, pin logs, or get system info.';
  readonly aliases = ['owner', 'broadcast', 'leave', 'botleave', 'pinout'];
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
              enum: ['broadcast', 'leave', 'system_info', 'pinout'],
              description: '"broadcast" to send a message to all rooms, "leave" to leave the current group, "system_info" for bot stats, "pinout" for log inventory.',
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
      // The parser resolves the `/broadcast` alias to `action = 'broadcast'` and
      // puts the user's text in `message`. Re-joining `action` into the body —
      // as this did — prefixed the literal word "broadcast" to every owner
      // broadcast, silently, on the exact path an earlier fix had just repaired.
      return this.handleBroadcast(message || undefined, ctx, lang);
    }
    if ((cmd === 'leave' || cmd === 'botleave') && !['broadcast', 'system_info', 'pinout'].includes(String(action))) {
      return this.handleLeave(ctx, lang);
    }

    switch (action) {
      case 'broadcast':
        return this.handleBroadcast(message, ctx, lang);
      case 'leave':
        return this.handleLeave(ctx, lang);
      case 'pinout':
        return this.handlePinout(ctx, lang);
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

    // Full rows are selected so the canonical `room_key` column is read when it
    // exists; delivery still uses the raw provider room id below.
    const rooms = db.select().from(chatRooms).where(eq(chatRooms.platform, ctx.platform)).all();

    if (rooms.length === 0) {
      return t(lang, 'owner.broadcast_no_rooms');
    }

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const broadcastText = `📢 *Broadcast from Bot Owner:*\n\n${message}`;

    log.info({ roomCount: rooms.length, platform: ctx.platform }, 'Broadcast initiated');

    for (const room of rooms) {
      // Never broadcast into the room the command came from. The comparison is
      // canonical so a stored room key and a raw chat id both match.
      if (isSameRoom(ctx.platform, room.roomKey ?? room.id, ctx.chatId)) {
        skipped++;
        continue;
      }
      // Provider sends always use the raw remote room id, never a room key.
      const remoteRoomId = roomRemoteId(room, ctx.platform);
      if (!remoteRoomId) {
        skipped++;
        log.warn({ roomId: room.id, roomKey: room.roomKey }, 'Broadcast skipped: room has no usable provider id');
        continue;
      }
      try {
        if (ctx.sendToChat) {
          await ctx.sendToChat(remoteRoomId, broadcastText);
        } else {
          await ctx.forwardMessage(remoteRoomId, broadcastText);
        }
        sent++;
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (err) {
        failed++;
        log.warn({ err, roomId: remoteRoomId }, 'Broadcast failed for room');
      }
    }

    log.info({ sent, failed, skipped }, 'Broadcast finished');
    return t(lang, 'owner.broadcast_done', {
      sent: String(sent),
      failed: String(failed),
      total: String(sent + failed),
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
      return t(lang, 'owner.leave_error', { msg: 'Unable to leave group' });
    }
  }

  private async handleSystemInfo(_ctx: MessageContext): Promise<string> {
    const [roomCountRow] = db.select({ value: count() }).from(chatRooms).all();
    const roomCount = roomCountRow?.value ?? 0;
    const memUsage = process.memoryUsage();

    return [
      '🤖 *ElastraX System Info*',
      ` • ⬆️ Uptime: *${formatUptime(process.uptime())}*`,
      ` • 💬 Total Rooms: *${roomCount}*`,
      ` • 🧠 Memory: *${Math.round(memUsage.heapUsed / 1024 / 1024)}MB* / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      ` • 🏗️ Runtime: *Bun ${process.versions.bun || 'unknown'}*`,
    ].join('\n\n');
  }

    private async handlePinout(_ctx: MessageContext, lang: string): Promise<string> {
    const logRootDir = logRoot();
    const logPath = pathResolve(logRootDir);
    const shards: string[] = [];
    let totalSizeMB = 0;

    try {
      const entries = await fsPromises.readdir(logPath, { withFileTypes: true });
      const logFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
        .sort((_a: Dirent<string>, _b: Dirent<string>) => _b.name.localeCompare(_a.name));

      for (const file of logFiles) {
        if (shards.length >= 25) {
          const remaining = logFiles.length - 25;
          if (remaining > 0) shards.push(` • _…and ${remaining} more log files_`);
          break;
        }
        const stat = await fsPromises.stat(pathJoin(logPath, file.name));
        const sizeMB = stat.size / 1024 / 1024;
        totalSizeMB += sizeMB;
        const ageMs = Date.now() - stat.mtimeMs;
        const age = ageMs >= 86400000
          ? `${(ageMs / 86400000).toFixed(0)}d ago`
          : `${Math.round(ageMs / 3600000)}h ago`;
        const rotated = file.name.endsWith('.log.1') || file.name.match(/\.log\.\d+$/) !== null;
        shards.push(` • *${file.name}* — ${(sizeMB).toFixed(2)}MB, ${age}${rotated ? ' (rotated)' : ''}`);
      }
    } catch (error) {
      log.warn({ err: error }, 'Could not scan log directory');
      shards.push(` • _Could not read log directory (${String(error).slice(0, 80)})_`);
    }

    return [
      t(lang, 'admin.pinout_title'),
      `Logs are written under: \`${pathRelative(process.cwd(), logPath) || logPath}/\``,
      `Total size across scanned logs: *${totalSizeMB.toFixed(2)}MB*`,
      '',
      ...shards,
      '',
      t(lang, 'admin.pinout_tip'),
    ].join('\n\n');
  }
}

