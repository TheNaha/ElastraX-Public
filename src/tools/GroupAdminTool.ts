/**
 * @file src/tools/GroupAdminTool.ts
 * @description Comprehensive group management tool for WhatsApp groups.
 *
 * Handles all common group administration tasks:
 *   add      — Add a participant by phone number.
 *   remove   — Remove (kick) a participant.
 *   promote  — Promote a participant to group admin.
 *   demote   — Remove admin rights from a participant.
 *   mute     — Restrict who can send messages (admins only / everyone).
 *   link     — Get the group's invite link.
 *
 * Phone number normalisation:
 *  - Non-digit characters are stripped.
 *  - Numbers starting with `0` are assumed to be Indonesian and prefixed with `62`.
 *  - The result is appended with `@s.whatsapp.net` to form a valid JID.
 *
 * Works conversationally ("kick @John", "promote this user to admin")
 * and via slash commands: /kick, /add, /promote, /demote, /mute, /grouplink
 *
 * Permissions: admin
 */

import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';
import { t } from '../utils/i18n';

function normaliseJid(input: string): string | null {
  const digits = input.replace(/[^0-9]/g, '');
  if (!digits) return null;
  const normalized = digits.startsWith('0') ? `62${digits.slice(1)}` : digits;
  return `${normalized}@s.whatsapp.net`;
}

export class GroupAdminTool extends BaseTool {
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
              description: 'Phone number or JID of the target user. Required for add/remove/promote/demote.',
            },
          },
          required: ['action', 'user'],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    let { action, user } = args;
    const cmd = String(args.__command || '').toLowerCase();

    // Slash-command shorthand support:
    // /kick 628...  -> action inferred from alias, first arg treated as user
    const actionAliases: Record<string, string> = {
      kick: 'remove',
      add: 'add',
      promote: 'promote',
      demote: 'demote',
      mute: 'mute',
      unmute: 'unmute',
      grouplink: 'link',
    };
    const inferredAction = actionAliases[cmd];
    if (inferredAction) {
      if (!user && typeof action === 'string' && !['add', 'remove', 'promote', 'demote', 'mute', 'unmute', 'link'].includes(action)) {
        user = action;
      }
      action = inferredAction;
    }

    if (!ctx.isGroup) return t(lang, 'group.not_in_group');

    // ── INVITE LINK ────────────────────────────────────────────────────────────
    if (action === 'link') {
      if (!ctx.getGroupInviteLink) return t(lang, 'group.link_not_supported');
      try {
        const link = await ctx.getGroupInviteLink(ctx.chatId);
        return t(lang, 'group.link_success', { link });
      } catch (e: any) {
        return t(lang, 'group.error', { msg: e.message });
      }
    }

    // ── MUTE / UNMUTE ──────────────────────────────────────────────────────────
    if (action === 'mute' || action === 'unmute') {
      if (!ctx.setGroupSettings) return t(lang, 'group.not_supported');
      try {
        await ctx.setGroupSettings(ctx.chatId, action === 'mute' ? 'announcement' : 'not_announcement');
        const status = action === 'mute' ? 'muted (admins only)' : 'unmuted (everyone)';
        return t(lang, 'group.mute_success', { status });
      } catch (e: any) {
        return t(lang, 'group.error', { msg: e.message });
      }
    }

    // ── PARTICIPANT ACTIONS (require user JID) ─────────────────────────────────
    if (!user) return t(lang, 'group.invalid_phone');

    const userJid = normaliseJid(String(user));
    if (!userJid) return t(lang, 'group.invalid_phone');

    if (action === 'add' || action === 'remove') {
      if (!ctx.updateGroupParticipants) return t(lang, 'group.not_supported');
      try {
        await ctx.react?.('⏳');
        await ctx.updateGroupParticipants(action, [userJid]);
        const key = action === 'add' ? 'group.success_add' : 'group.success_remove';
        return t(lang, key, { jid: userJid });
      } catch (e: any) {
        logger.error(e, '[GroupAdminTool] add/remove failed');
        return t(lang, 'group.error', { msg: e.message });
      }
    }

    if (action === 'promote' || action === 'demote') {
      if (!ctx.updateGroupParticipants) return t(lang, 'group.not_supported');
      try {
        await ctx.react?.('⏳');
        // Baileys uses 'promote'/'demote' directly in updateGroupParticipants
        await ctx.updateGroupParticipants(action as any, [userJid]);
        const key = action === 'promote' ? 'group.promote_success' : 'group.demote_success';
        return t(lang, key, { jid: userJid });
      } catch (e: any) {
        logger.error(e, '[GroupAdminTool] promote/demote failed');
        return t(lang, 'group.error', { msg: e.message });
      }
    }

    return t(lang, 'group.invalid_action');
  }
}

