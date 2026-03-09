import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'IDTool' });

export class IDTool extends BaseTool<ToolArgs> {
  readonly name = 'get_id';
  readonly description = 'Show the current user\'s ID, the chat room ID, and platform info. Use this when the user asks "what is my ID", "what is the group ID", or "who am I".';
  readonly aliases = ['id', 'whoami'];
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
    log.debug({ senderId: ctx.senderId, chatId: ctx.chatId, platform: ctx.platform }, 'ID lookup requested');
    const roles = await ctx.resolveRoles();
    return t(ctx.language, 'id.response', {
      name: ctx.senderName,
      userId: ctx.senderId,
      chatId: ctx.chatId,
      platform: ctx.platform,
      isGroup: ctx.isGroup ? 'Yes' : 'No',
      permissions: roles.join(', '),
    });
  }
}
