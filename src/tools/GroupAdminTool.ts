import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';
import { t } from '../utils/i18n';

export class GroupAdminTool extends BaseTool {
  readonly name = 'groupadmin';
  readonly description = 'Manage group participants (kick or add users to a WhatsApp group).';
  readonly aliases = ['kick', 'add'];
  readonly category = 'admin';
  readonly permissions = 'admin';

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'Action to perform: "add" or "remove"' },
            user: { type: 'string', description: 'Phone number of the user (e.g., 6281234567890)' }
          },
          required: ['action', 'user']
        }
      }
    };
  }

  async execute(args: Record<string, any>, ctx: MessageContext): Promise<string> {
    if (!ctx.isGroup) {
      return t(ctx.language, 'group.not_in_group');
    }

    const { action, user } = args;

    if (action !== 'add' && action !== 'remove') {
      return t(ctx.language, 'group.invalid_action');
    }

    // Attempt to format the phone number as a WhatsApp JID natively
    let rawNumber = user.replace(/[^0-9]/g, '');
    if (!rawNumber) return t(ctx.language, 'group.invalid_phone');

    // Default country code logic simplified: if starts with 0 replace with indonesian +62 code
    if (rawNumber.startsWith('0')) {
        rawNumber = '62' + rawNumber.slice(1);
    }
    const userJid = `${rawNumber}@s.whatsapp.net`;

    try {
      if (!ctx.updateGroupParticipants) {
        return t(ctx.language, 'group.not_supported');
      }

      await ctx.react?.('⏳');
      await ctx.updateGroupParticipants(action, [userJid]);

      const key = action === 'add' ? 'group.success_add' : 'group.success_remove';
      return t(ctx.language, key, { jid: userJid });

    } catch (e: any) {
      logger.error(e, 'Failed to administer group');
      return t(ctx.language, 'group.error', { msg: e.message || 'Unknown error' });
    }
  }
}
