import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { resolveTargetUser } from '../utils/resolveTargetUser';
import { logger } from '../utils/logger';
import { t } from '../utils/i18n';
import { getErrorMessage } from '../utils/errorUtils';

const log = logger.child({ module: 'GroupAdminTool' });

type GroupAdminAction = 'add' | 'remove' | 'promote' | 'demote' | 'mute' | 'unmute' | 'link';
type GroupParticipantAction = 'add' | 'remove' | 'promote' | 'demote';
type GroupAdminArgs = ToolArgs & {
  action?: GroupAdminAction | string;
  user?: string;
};

const ACTION_ALIASES: Record<string, GroupAdminAction> = {
  kick: 'remove',
  add: 'add',
  promote: 'promote',
  demote: 'demote',
  mute: 'mute',
  unmute: 'unmute',
  grouplink: 'link',
};

function isParticipantAction(action: string): action is GroupParticipantAction {
  return action === 'add' || action === 'remove' || action === 'promote' || action === 'demote';
}

export class GroupAdminTool extends BaseTool<GroupAdminArgs> {
  readonly name = 'groupadmin';
  readonly description = 'Manage a WhatsApp group: add or remove participants, promote/demote admins, mute/unmute the group, or get the invite link. Only works in groups and requires the bot to be a group admin.';
  readonly aliases = ['group_admin', 'group-admin', 'kick', 'add', 'promote', 'demote', 'mute', 'unmute', 'grouplink'];
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
            action: {
              type: 'string',
              enum: ['add', 'remove', 'promote', 'demote', 'mute', 'unmute', 'link'],
              description: 'The group action to perform.',
            },
            user: {
              type: 'string',
              description: 'Target user: phone number, JID, "mentioned" (if @mentioned), or "quoted" (if replying to their message). Resolved automatically from context when omitted.',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  async execute(args: GroupAdminArgs, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    let { action, user } = args;
    const cmd = String(args.__command || '').toLowerCase();

    log.debug({ action, user, cmd, chatId: ctx.chatId, senderId: ctx.senderId }, 'Group admin action requested');

    const inferredAction = ACTION_ALIASES[cmd];
    if (inferredAction) {
      if (!user && typeof action === 'string' && !Object.values(ACTION_ALIASES).includes(action as GroupAdminAction)) {
        user = action;
      }
      action = inferredAction;
    }

    if (!ctx.isGroup) return t(lang, 'group.not_in_group');

    if (action === 'link') {
      if (!ctx.getGroupInviteLink) return t(lang, 'group.link_not_supported');
      try {
        const link = await ctx.getGroupInviteLink(ctx.chatId);
        log.info({ chatId: ctx.chatId, requestedBy: ctx.senderId }, 'Group invite link retrieved');
        return t(lang, 'group.link_success', { link });
      } catch (error: unknown) {
        return t(lang, 'group.error', { msg: getErrorMessage(error) });
      }
    }

    if (action === 'mute' || action === 'unmute') {
      if (!ctx.setGroupSettings) return t(lang, 'group.not_supported');
      try {
        await ctx.setGroupSettings(ctx.chatId, action === 'mute' ? 'announcement' : 'not_announcement');
        const status = action === 'mute' ? 'muted (admins only)' : 'unmuted (everyone)';
        log.info({ chatId: ctx.chatId, action, requestedBy: ctx.senderId }, 'Group mute setting changed');
        return t(lang, 'group.mute_success', { status });
      } catch (error: unknown) {
        return t(lang, 'group.error', { msg: getErrorMessage(error) });
      }
    }

    if (!action || !isParticipantAction(action)) {
      return t(lang, 'group.invalid_action');
    }

    const target = resolveTargetUser({ ...args, user }, ctx, 'user');
    if (!target) return t(lang, 'group.invalid_phone');
    const userJid = target.jid;

    try {
      if (!ctx.updateGroupParticipants) return t(lang, 'group.not_supported');

      await ctx.react?.('\u23F3');
      await ctx.updateGroupParticipants(action, [userJid]);

      if (action === 'add' || action === 'remove') {
        log.info({ chatId: ctx.chatId, action, targetJid: userJid, requestedBy: ctx.senderId }, 'Group participant updated');
        const key = action === 'add' ? 'group.success_add' : 'group.success_remove';
        return t(lang, key, { jid: userJid });
      }

      log.info({ chatId: ctx.chatId, action, targetJid: userJid, requestedBy: ctx.senderId }, 'Group participant role changed');
      const key = action === 'promote' ? 'group.promote_success' : 'group.demote_success';
      return t(lang, key, { jid: userJid });
    } catch (error: unknown) {
      log.error({ err: error, action, targetJid: userJid, chatId: ctx.chatId }, 'Group action failed');
      return t(lang, 'group.error', { msg: getErrorMessage(error) });
    }
  }
}



