/**
 * @file src/tools/MediaBindTool.ts
 * @description Account binding + notification management for media services.
 *
 * Actions: connect, disconnect, notify, status
 * Uses FlowHandler for the multi-step connect flow (username/password collection).
 */

import { BaseTool, type ToolDefinition, type ToolResult } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { FlowHandler } from '../core/FlowHandler';
import { SessionManager } from '../utils/SessionManager';
import { ServiceBindingService } from '../utils/ServiceBindingService';
import { NotificationSubscriptionService } from '../utils/NotificationSubscriptionService';
import { SeerrClient } from '../providers/seerr/SeerrClient';
import { JellyfinClient } from '../providers/jellyfin/JellyfinClient';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'MediaBindTool' });

type MediaBindArgs = {
  action: 'connect' | 'disconnect' | 'notify' | 'status';
  notify_action?: 'here' | 'add' | 'remove' | 'list';
  room_id?: string;
  __command?: string;
};

export const mediaBindToolDeps = {
  createSeerrClient: () => new SeerrClient(),
  createJellyfinClient: () => new JellyfinClient(),
  bindingService: ServiceBindingService,
  notificationService: NotificationSubscriptionService,
};

// ── Flow Registration ───────────────────────────────────────────────────────

export const mediaConnectFlowProcessor = async (
  ctx: MessageContext,
  flowData: { step: string; data: Record<string, unknown> },
  _flowId?: string,
) => {
  const { step, data } = flowData;

  if (step === 'username') {
    const username = ctx.text.trim();
    if (!username) {
      await ctx.reply('Please enter your username for the streaming service.');
      return;
    }
    SessionManager.set(
      ctx.senderId,
      'media_connect',
      { flow: 'media_connect', step: 'password', data: { ...data, username } },
      ctx.platform,
      120,
    );
    await ctx.reply('Now enter your password. (Your message will be processed securely.)');
    return;
  }

  if (step === 'password') {
    const password = ctx.text.trim();
    if (!password) {
      await ctx.reply('Please enter your password.');
      return;
    }

    const username = data.username as string;

    await ctx.reply('⏳ Authenticating...');

    try {
      const seerrClient = mediaBindToolDeps.createSeerrClient();
      const jellyfinClient = mediaBindToolDeps.createJellyfinClient();

      // Try Seerr Jellyfin auth first (handles both)
      let authResult;
      let jellyfinUserId: string;
      let jellyfinUsername: string;
      let isAdmin = false;
      let seerrUserId: number | undefined;
      let seerrEmail: string | undefined;

      if (seerrClient.isConfigured) {
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
      } else if (jellyfinClient.isConfigured) {
        // Fallback: direct Jellyfin auth
        authResult = await jellyfinClient.authenticateUser(username, password);
        jellyfinUserId = authResult.User.Id;
        jellyfinUsername = authResult.User.Name;
        isAdmin = authResult.User.Policy?.IsAdministrator === true;
      } else {
        SessionManager.clear(ctx.senderId, 'media_connect', ctx.platform);
        await ctx.reply('❌ Media services are not configured. Please contact the bot admin.');
        return;
      }

      const metadata = JSON.stringify({ isAdmin, seerrUserId });

      // Bind Jellyfin
      if (jellyfinUserId!) {
        await mediaBindToolDeps.bindingService.bind({
          userId: ctx.senderId,
          platform: ctx.platform,
          serviceType: 'jellyfin',
          externalUserId: jellyfinUserId,
          externalUsername: jellyfinUsername!,
          externalEmail: seerrEmail,
          metadata,
        });
      }

      // Bind Seerr
      if (seerrUserId !== undefined) {
        await mediaBindToolDeps.bindingService.bind({
          userId: ctx.senderId,
          platform: ctx.platform,
          serviceType: 'seerr',
          externalUserId: String(seerrUserId),
          externalUsername: jellyfinUsername!,
          externalEmail: seerrEmail,
          metadata,
        });
      }

      SessionManager.clear(ctx.senderId, 'media_connect', ctx.platform);

      const adminLabel = isAdmin ? ' (Admin)' : '';
      await ctx.reply(
        `✅ Account linked successfully!${adminLabel}\n` +
        `Username: ${jellyfinUsername!}\n\n` +
        `Would you like to receive media notifications in this chat? ` +
        `Use the notify command to manage notification preferences.`,
      );
    } catch (err: unknown) {
      SessionManager.clear(ctx.senderId, 'media_connect', ctx.platform);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      log.error({ err, username }, 'Media connect authentication failed');
      await ctx.reply(`❌ Authentication failed: ${msg}\nPlease check your credentials and try again.`);
    }
    return;
  }
};

FlowHandler.register('media_connect', mediaConnectFlowProcessor);

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
        return 'Available actions: connect, disconnect, notify, status';
    }
  }

  private async handleConnect(ctx: MessageContext): Promise<ToolResult> {
    const seerrClient = mediaBindToolDeps.createSeerrClient();
    const jellyfinClient = mediaBindToolDeps.createJellyfinClient();

    if (!seerrClient.isConfigured && !jellyfinClient.isConfigured) {
      return '❌ Media services are not configured.';
    }

    // Check if already bound
    const existing = await mediaBindToolDeps.bindingService.getBinding(ctx.senderId, ctx.platform, 'jellyfin');
    if (existing) {
      return `You already have a linked account (${existing.externalUsername}). Use disconnect first if you want to relink.`;
    }

    // Start the flow
    SessionManager.set(
      ctx.senderId,
      'media_connect',
      { flow: 'media_connect', step: 'username', data: {} },
      ctx.platform,
      120,
    );

    return 'Let\'s link your media account. Please enter your username:';
  }

  private async handleDisconnect(ctx: MessageContext): Promise<ToolResult> {
    const jfRemoved = await mediaBindToolDeps.bindingService.unbind(ctx.senderId, ctx.platform, 'jellyfin');
    const srRemoved = await mediaBindToolDeps.bindingService.unbind(ctx.senderId, ctx.platform, 'seerr');

    if (!jfRemoved && !srRemoved) {
      return 'You don\'t have any linked media accounts.';
    }

    return '✅ Media account unlinked successfully.';
  }

  private async handleNotify(args: MediaBindArgs, ctx: MessageContext): Promise<ToolResult> {
    const notifyAction = args.notify_action ?? 'here';

    switch (notifyAction) {
      case 'here': {
        await mediaBindToolDeps.notificationService.subscribe({
          userId: ctx.senderId,
          platform: ctx.platform,
          serviceType: 'all',
          chatRoomId: ctx.chatId,
        });
        return '✅ This chat will now receive media notifications.';
      }

      case 'add': {
        const roomId = args.room_id?.trim();
        if (!roomId) return 'Please specify a room ID.';
        await mediaBindToolDeps.notificationService.subscribe({
          userId: ctx.senderId,
          platform: ctx.platform,
          serviceType: 'all',
          chatRoomId: roomId,
        });
        return `✅ Room ${roomId} will now receive media notifications.`;
      }

      case 'remove': {
        const roomId = args.room_id?.trim() || ctx.chatId;
        const removed = await mediaBindToolDeps.notificationService.unsubscribe(
          ctx.senderId, ctx.platform, 'all', roomId,
        );
        return removed
          ? `✅ Room ${roomId} will no longer receive media notifications.`
          : `No notification subscription found for that room.`;
      }

      case 'list': {
        const subs = await mediaBindToolDeps.notificationService.getSubscriptions(ctx.senderId, ctx.platform);
        if (subs.length === 0) return 'You have no notification subscriptions.';

        const lines = subs.map((sub, i) => {
          const types = sub.notifyTypes ? JSON.parse(sub.notifyTypes).join(', ') : 'all';
          return `${i + 1}. ${sub.chatRoomId} (${sub.serviceType}) — ${types}`;
        });
        return `📋 *Your notification subscriptions:*\n${lines.join('\n')}`;
      }

      default:
        return 'Available notify actions: here, add, remove, list';
    }
  }

  private async handleStatus(ctx: MessageContext): Promise<ToolResult> {
    const bindings = await mediaBindToolDeps.bindingService.getBindings(ctx.senderId, ctx.platform);
    if (bindings.length === 0) {
      return 'You don\'t have any linked media accounts. Use connect to link your account.';
    }

    const lines = bindings.map((b) => {
      let meta = '';
      if (b.metadata) {
        try {
          const m = JSON.parse(b.metadata);
          if (m.isAdmin) meta = ' 👑 Admin';
        } catch { /* ignore */ }
      }
      return `• ${b.serviceType}: ${b.externalUsername}${meta}`;
    });

    const subs = await mediaBindToolDeps.notificationService.getSubscriptions(ctx.senderId, ctx.platform);
    const subLines = subs.length > 0
      ? subs.map((s) => `  📍 ${s.chatRoomId} (${s.serviceType})`).join('\n')
      : '  (none)';

    return `📋 *Linked Accounts:*\n${lines.join('\n')}\n\n📬 *Notification Rooms:*\n${subLines}`;
  }
}
