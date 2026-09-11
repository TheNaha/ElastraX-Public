/**
 * @file src/tools/MediaBindTool.ts
 * @description Account binding + notification management for media services.
 *
 * Actions: connect, disconnect, notify, status
 * Uses FlowHandler for the multi-step connect flow (username/password collection).
 */

import { BaseTool, type ToolDefinition, type ToolResult } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { FlowHandler, type FlowProcessor } from '../core/FlowHandler';
import { MediaService } from '../utils/MediaService';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { t } from '../utils/i18n';

const log = logger.child({ module: 'MediaBindTool' });

type MediaBindArgs = {
  action: 'connect' | 'disconnect' | 'notify' | 'status';
  notify_action?: 'here' | 'add' | 'remove' | 'list';
  room_id?: string;
  __command?: string;
};

// MediaService is used instead of local deps

// ── Flow Processor ────────────────────────────────────────────────────────

export const mediaConnectFlowProcessor: FlowProcessor = async (ctx, flowData) => {
  const { step, data } = flowData;
  const flowId = 'media_connect';

  if (step === 'username') {
    const username = ctx.text.trim();
    if (!username) {
      await ctx.reply(t(ctx.language, 'media.username_prompt') || 'Please enter your username for the streaming service.');
      return;
    }
    FlowHandler.setSession(
      ctx.senderId,
      'media_connect',
      { flow: 'media_connect', step: 'password', data: { ...data, username } },
      ctx.platform,
      120,
    );
    await ctx.reply(t(ctx.language, 'media.password_prompt') || 'Now enter your password. (Your message will be processed securely.)');
    return;
  }

  if (step === 'password') {
    const password = ctx.text.trim();
    if (!password) {
      await ctx.reply(t(ctx.language, 'media.password_prompt') || 'Now enter your password. (Your message will be processed securely.)');
      return;
    }

    const username = data.username as string;

    await ctx.reply('⏳ Authenticating...');

    try {
      const seerrClient = MediaService.createSeerrClient();
      const jellyfinClient = MediaService.createJellyfinClient();

      // Try Seerr Jellyfin auth first (handles both)
      let jellyfinUserId: string;
      let jellyfinUsername: string;
      let isAdmin = false;
      let seerrUserId: number | undefined;
      let seerrEmail: string | undefined;

      if (seerrClient.isConfigured && seerrClient.authenticateJellyfin) {
        const seerrAuth = await seerrClient.authenticateJellyfin(username, password);
        seerrUserId = seerrAuth.id;
        seerrEmail = seerrAuth.email;
        jellyfinUserId = seerrAuth.jellyfinUserId ?? '';
        jellyfinUsername = seerrAuth.displayName ?? username;

        // If we got a Jellyfin user ID, check admin status via Jellyfin API
        if (jellyfinUserId && jellyfinClient.isConfigured) {
          try {
            const jfUser = await jellyfinClient.getUserById(jellyfinUserId);
            isAdmin = jfUser.Policy?.IsAdministrator === true;
          } catch {
            log.warn({ jellyfinUserId }, 'Could not fetch Jellyfin user for admin check');
          }
        }
      } else if (seerrClient.isConfigured) {
        // Seerr configured but no Jellyfin auth — try direct Seerr auth
        const seerrAuth = await seerrClient.authenticateJellyfin(username, password);
        seerrUserId = seerrAuth.id;
        seerrEmail = seerrAuth.email;
        jellyfinUserId = seerrAuth.jellyfinUserId ?? '';
        jellyfinUsername = seerrAuth.displayName ?? username;
      } else if (jellyfinClient.isConfigured) {
        // Fallback: direct Jellyfin auth
        const authResult = await jellyfinClient.authenticateUser(username, password);
        jellyfinUserId = authResult.User.Id;
        jellyfinUsername = authResult.User.Name;
        isAdmin = authResult.User.Policy?.IsAdministrator === true;
      } else {
        FlowHandler.clearSession(ctx.senderId, 'media_connect', ctx.platform);
        await ctx.reply(t(ctx.language, 'media.not_configured') || '❌ Media services are not configured. Please contact the bot admin.');
        return;
      }

      const metadata = JSON.stringify({ isAdmin, seerrUserId });

      // Bind Jellyfin
      if (jellyfinUserId && jellyfinUserId.length > 0) {
        await MediaService.bindingService.bind({
          userId: ctx.senderId,
          platform: ctx.platform,
          serviceType: 'jellyfin',
          externalUserId: jellyfinUserId,
          externalUsername: jellyfinUsername ?? username,
          externalEmail: seerrEmail,
          metadata,
        });
      }

      // Bind Seerr
      if (seerrUserId !== undefined) {
        await MediaService.bindingService.bind({
          userId: ctx.senderId,
          platform: ctx.platform,
          serviceType: 'seerr',
          externalUserId: String(seerrUserId),
          externalUsername: jellyfinUsername ?? username,
          externalEmail: seerrEmail,
          metadata,
        });
      }

      FlowHandler.clearSession(ctx.senderId, 'media_connect', ctx.platform);

      const adminLabel = isAdmin ? ' 👑 ' : '';
      const adminText = adminLabel + (isAdmin ? t(ctx.language, 'media.admin_label') || '(Admin)' : '');
      await ctx.reply(
        `${t(ctx.language, 'media.connected') || '✅ Account linked successfully!'}${adminText}\n` +
        `${t(ctx.language, 'media.connected_username') || 'Username:'} ${jellyfinUsername ?? username}\n\n` +
        `${t(ctx.language, 'media.notify_hint') || 'Would you like to receive media notifications in this chat? Use the notify command to manage notification preferences.'}`,
      );
    } catch (err: unknown) {
      FlowHandler.clearSession(ctx.senderId, 'media_connect', ctx.platform);
      const msg = getErrorMessage(err);
      log.error({ err, username }, 'Media connect authentication failed');
      await ctx.reply(`${t(ctx.language, 'media.auth_failed') || '❌ Authentication failed:'} ${msg}\n${t(ctx.language, 'media.auth_retry') || 'Please check your credentials and try again.'}`);
    }
    return;
  }
};

// ── Tool Class ──────────────────────────────────────────────────────────────

export class MediaBindTool extends BaseTool {
  readonly name = 'media_account';
  readonly description = 'Link or manage your streaming/media service account and notification preferences.';
  readonly aliases = ['connect', 'disconnect', 'notify'];
  readonly category = 'media';
  readonly permissions = 'user';

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
              enum: ['connect', 'disconnect', 'notify', 'status'],
              description: 'The action to perform: connect (link account), disconnect (unlink), notify (manage notifications), status (show current bindings).',
            },
            notify_action: {
              type: 'string',
              enum: ['here', 'add', 'remove', 'list'],
              description: 'For notify action: here (subscribe this chat), add (subscribe a room), remove (unsubscribe), list (show subscriptions).',
            },
            room_id: {
              type: 'string',
              description: 'Chat room ID for notify add/remove actions.',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  async execute(args: MediaBindArgs, ctx: MessageContext): Promise<ToolResult> {
    const cmd = String(args.__command || '').toLowerCase();
    let { action } = args;

    // Infer action from slash alias
    if (!action && cmd) {
      if (cmd === 'connect') action = 'connect';
      else if (cmd === 'disconnect') action = 'disconnect';
      else if (cmd === 'notify') action = 'notify';
      else action = 'status';
    }

    log.debug({ action, senderId: ctx.senderId }, 'MediaBind action');

    switch (action) {
      case 'connect':
        return this.handleConnect(ctx);
      case 'disconnect':
        return this.handleDisconnect(ctx);
      case 'notify':
        return this.handleNotify(args, ctx);
      case 'status':
        return this.handleStatus(ctx);
      default:
        return t(ctx.language, 'media.actions_list') || 'Available actions: connect, disconnect, notify, status';
    }
  }

  private async handleConnect(ctx: MessageContext): Promise<ToolResult> {
    const seerrClient = MediaService.createSeerrClient();
    const jellyfinClient = MediaService.createJellyfinClient();

    if (!seerrClient.isConfigured && !jellyfinClient.isConfigured) {
      return t(ctx.language, 'media.not_configured') || '❌ Media services are not configured.';
    }

    // Check if already bound
    const existing = await MediaService.bindingService.getBinding(ctx.senderId, ctx.platform, 'jellyfin');
    if (existing) {
      return t(ctx.language, 'media.already_bound', { username: existing.externalUsername })
        || `You already have a linked account (${existing.externalUsername}). Use disconnect first if you want to relink.`;
    }

    // Start the flow
    FlowHandler.setSession(
      ctx.senderId,
      'media_connect',
      { flow: 'media_connect', step: 'username', data: {} },
      ctx.platform,
      120,
    );

    return t(ctx.language, 'media.connect_start') || 'Let\'s link your media account. Please enter your username:';
  }

  private async handleDisconnect(ctx: MessageContext): Promise<ToolResult> {
    const jfRemoved = await MediaService.bindingService.unbind(ctx.senderId, ctx.platform, 'jellyfin');
    const srRemoved = await MediaService.bindingService.unbind(ctx.senderId, ctx.platform, 'seerr');

    if (!jfRemoved && !srRemoved) {
      return t(ctx.language, 'media.no_binding') || 'You don\'t have any linked media accounts.';
    }

    return t(ctx.language, 'media.unlinked') || '✅ Media account unlinked successfully.';
  }

  private async handleNotify(args: MediaBindArgs, ctx: MessageContext): Promise<ToolResult> {
    const notifyAction = args.notify_action ?? 'here';

    switch (notifyAction) {
      case 'here': {
        await MediaService.notificationService.subscribe({
          userId: ctx.senderId,
          platform: ctx.platform,
          serviceType: 'all',
          chatRoomId: ctx.chatId,
        });
        return t(ctx.language, 'media.notify_here') || '✅ This chat will now receive media notifications.';
      }

      case 'add': {
        const roomId = args.room_id?.trim();
        if (!roomId) return t(ctx.language, 'media.notify_add_prompt') || 'Please specify a room ID.';
        await MediaService.notificationService.subscribe({
          userId: ctx.senderId,
          platform: ctx.platform,
          serviceType: 'all',
          chatRoomId: roomId,
        });
        return t(ctx.language, 'media.notify_added', { room: roomId })
          || `✅ Room ${roomId} will now receive media notifications.`;
      }

      case 'remove': {
        const roomId = args.room_id?.trim() || ctx.chatId;
        const removed = await MediaService.notificationService.unsubscribe(
          ctx.senderId, ctx.platform, 'all', roomId,
        );
        return removed
          ? (t(ctx.language, 'media.notify_removed', { room: roomId }) || `✅ Room ${roomId} will no longer receive media notifications.`)
          : (t(ctx.language, 'media.notify_not_found') || `No notification subscription found for that room.`);
      }

      case 'list': {
        const subs = await MediaService.notificationService.getSubscriptions(ctx.senderId, ctx.platform);
        if (subs.length === 0) return t(ctx.language, 'media.notify_list_empty') || 'You have no notification subscriptions.';

        const lines = subs.map((sub, i) => {
          const types = sub.notifyTypes ? JSON.parse(sub.notifyTypes).join(', ') : t(ctx.language, 'media.notify_types_all') || 'all';
          return ` • ${sub.chatRoomId} (${sub.serviceType}) — ${types} (ID: ${i + 1})`;
        });
        return `${t(ctx.language, 'media.notify_list_header') || '📋 *Your notification subscriptions:*'}\n${lines.join('\n\n')}`;
      }

      default:
        return t(ctx.language, 'media.notify_actions_list') || 'Available notify actions: here, add, remove, list';
    }
  }

  private async handleStatus(ctx: MessageContext): Promise<ToolResult> {
    const bindings = await MediaService.bindingService.getBindings(ctx.senderId, ctx.platform);
    if (bindings.length === 0) {
      return t(ctx.language, 'media.no_binding_status') || 'You don\'t have any linked media accounts. Use connect to link your account.';
    }

    const lines = bindings.map((b) => {
      let meta = '';
      if (b.metadata) {
        try {
          const m = JSON.parse(b.metadata);
          if (m.isAdmin) {
            meta = ' 👑 ' + (t(ctx.language, 'media.admin_label') || 'Admin');
          }
        } catch { /* ignore */ }
      }
      return ` • ${b.serviceType}: ${b.externalUsername}${meta}`;
    });

    const subs = await MediaService.notificationService.getSubscriptions(ctx.senderId, ctx.platform);
    const subLines = subs.length > 0
      ? subs.map((s) => ` • ${s.chatRoomId} (${s.serviceType})`).join('\n\n')
      : '_None_';

    return `${t(ctx.language, 'media.status_header') || '📋 *Linked Accounts:*'}\n${lines.join('\n\n')}\n\n${t(ctx.language, 'media.status_notify_header') || '📬 *Notification Rooms:*'}\n${subLines}`;
  }
}
