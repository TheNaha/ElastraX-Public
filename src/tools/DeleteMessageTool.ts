import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';

const log = logger.child({ module: 'DeleteMessageTool' });

type DeleteMessageKey = { fromMe?: boolean };
type DeleteTarget = { key?: DeleteMessageKey };

export class DeleteMessageTool extends BaseTool<ToolArgs> {
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

  async execute(_args: ToolArgs, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';

    if (!ctx.deleteMessage) {
      return t(lang, 'delete.not_supported');
    }

    if (!ctx.quoted) {
      return t(lang, 'delete.no_quoted');
    }

    const deleteTarget = ctx.quoted.rawMessage as DeleteTarget | undefined;
    if (deleteTarget?.key?.fromMe !== true) {
      return t(lang, 'delete.not_bot_message');
    }

    try {
      await ctx.deleteMessage(deleteTarget.key);
      log.info({ chatId: ctx.chatId, requestedBy: ctx.senderId }, 'Bot message deleted');
      return t(lang, 'delete.success');
    } catch (error: unknown) {
      log.error({ err: error, chatId: ctx.chatId }, 'Failed to delete message');
      return t(lang, 'delete.error', { msg: getErrorMessage(error) });
    }
  }
}
