/**
 * @file src/tools/DeleteMessageTool.ts
 * @description Delete the bot's last message (or a specific quoted bot message).
 *
 * On WhatsApp, only the bot's own messages can be deleted for everyone.
 * The user must reply to a bot message or say "delete your last message" — the
 * LLM maps either form to this tool.
 *
 * Works conversationally ("delete that", "remove your last message")
 * and via slash command (/delete, /del — must reply to a bot message).
 *
 * Slash command aliases: /delete, /del, /unsend
 */

import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'DeleteMessageTool' });

export class DeleteMessageTool extends BaseTool {
  readonly name = 'delete_message';
  readonly description = 'Delete one of the bot\'s own previously sent messages. The user must reply to the bot message they want deleted, or explicitly ask to delete the last bot message.';
  readonly aliases = ['delete', 'del', 'unsend'];
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

    if (!ctx.deleteMessage) {
      return t(lang, 'delete.not_supported');
    }

    // Must be replying to a bot message
    if (!ctx.quoted) {
      return t(lang, 'delete.no_quoted');
    }

    // Only allow deleting messages sent by the bot (fromMe === true)
    const isFromBot = ctx.quoted.rawMessage?.key?.fromMe === true;
    if (!isFromBot) {
      return t(lang, 'delete.not_bot_message');
    }

    try {
      await ctx.deleteMessage(ctx.quoted.rawMessage?.key);
      log.info({ chatId: ctx.chatId, requestedBy: ctx.senderId }, 'Bot message deleted');
      return t(lang, 'delete.success');
    } catch (err: any) {
      log.error({ err, chatId: ctx.chatId }, 'Failed to delete message');
      return t(lang, 'delete.error', { msg: err.message });
    }
  }
}
