import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';

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
      return "❌ This command can only be used in a group.";
    }

    const { action, user } = args;

    if (action !== 'add' && action !== 'remove') {
      return "❌ Invalid action. Must be 'add' or 'remove'.";
    }

    // Attempt to format the phone number as a WhatsApp JID natively
    let rawNumber = user.replace(/[^0-9]/g, '');
    if (!rawNumber) return "❌ Invalid user phone number.";
    
    // Default country code logic simplified: if starts with 0 replace with indonesian +62 code
    if (rawNumber.startsWith('0')) {
        rawNumber = '62' + rawNumber.slice(1);
    }
    const userJid = `${rawNumber}@s.whatsapp.net`;

    try {
      if (!ctx.updateGroupParticipants) {
        return "❌ Group Administration is not supported by the current adapter.";
      }

      await ctx.react?.('⏳');
      await ctx.updateGroupParticipants(action, [userJid]);
      
      const actionText = action === 'add' ? 'Added' : 'Removed';
      return `✅ Successfully ${actionText} user ${userJid}.`;
      
    } catch (e: any) {
      logger.error(e, 'Failed to administer group');
      return `❌ Error administering group: ${e.message || 'Unknown error'}. Note: Ensure the bot is an admin of the group.`;
    }
  }
}
