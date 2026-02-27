/**
 * @file src/tools/IDTool.ts
 * @description Reveals platform identifiers for the current user and chat room.
 *
 * Very useful for debugging, for users wanting to find their chat/group ID
 * (e.g., to configure webhook targets or admin tools), and for admins who
 * need to whitelist specific JIDs.
 *
 * Works conversationally ("what's my ID?", "show me this group's ID")
 * and via slash command (/id).
 *
 * Slash command aliases: /id, /whoami
 */

import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'IDTool' });

export class IDTool extends BaseTool {
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

  async execute(_args: Record<string, any>, ctx: MessageContext): Promise<string> {
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
