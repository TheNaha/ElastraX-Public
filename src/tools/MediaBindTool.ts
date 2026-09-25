/**
 * @file src/tools/MediaBindTool.ts
 * @description Account binding + notification management for media services.
 *
 * Actions: connect, disconnect, notify, status
 * Uses FlowHandler for the multi-step connect flow (username/password collection).
 */

import { BaseTool, type ToolDefinition, type ToolResult, type ToolCommandGrammar } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { FlowHandler, type FlowProcessor } from '../core/FlowHandler';
import { MediaService } from '../utils/MediaService';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { t } from '../utils/i18n';
import { getCanonicalRoomKey, isSameRoom, toRoomKey } from '../agent/roomKey';

const log = logger.child({ module: 'MediaBindTool' });

export interface NotificationDestinationContext extends MessageContext {
  verifyRoomMembership?: (roomId: string, platform?: string) => Promise<boolean>;
}

/**
 * True when a destination reference denotes the context's own room.
 * The reference may be a raw provider room id or a canonical room key, so both
 * forms are compared.
 */
function isCurrentRoom(ctx: MessageContext, roomId: string): boolean {
  return (
    isSameRoom(ctx.platform, roomId, ctx.chatId) ||
    isSameRoom(ctx.platform, roomId, getCanonicalRoomKey(ctx))
  );
}

export async function authorizeNotificationDestination(ctx: NotificationDestinationContext, roomId: string): Promise<boolean> {
  if (isCurrentRoom(ctx, roomId)) return true;
  if (!(await ctx.checkPermissions('owner'))) return false;
  if (typeof ctx.verifyRoomMembership !== 'function') return false;
  try {
    return await ctx.verifyRoomMembership(roomId, ctx.platform) === true;
  } catch (error: unknown) {
    log.warn({ err: error, roomId, platform: ctx.platform }, 'Foreign notification room membership verification failed');
    return false;
  }
}

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

  if (ctx.isGroup) {
    await FlowHandler.clearSession(ctx.senderId, flowId, ctx.platform, ctx.chatId);
    await ctx.reply('❌ Media account linking is only available in a direct message.');
    return;
  }

  if (step === 'username') {
    const username = ctx.text.trim();
    if (!username) {
      await ctx.reply(t(ctx.language, 'media.username_prompt') || 'Please enter your username for the streaming service.');
      return;
    }
    await FlowHandler.setSession(
      ctx.senderId,
      'media_connect',
      { flow: 'media_connect', step: 'password', data: { ...data, username }, roomId: ctx.chatId },
      ctx.platform,
      120,
      ctx.chatId,
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

      let jellyfinUserId = '';
      let jellyfinUsername = username;
      let isAdmin = false;
      let seerrUserId: number | undefined;
      let seerrEmail: string | undefined;

      if (seerrClient.isConfigured && typeof seerrClient.authenticateJellyfin === 'function') {
        const seerrAuth = await seerrClient.authenticateJellyfin(username, password);
        const verifiedSeerrId = Number(seerrAuth?.id);
        if (!Number.isInteger(verifiedSeerrId) || verifiedSeerrId <= 0) throw new Error('The service returned an invalid verified user id.');
        seerrUserId = verifiedSeerrId;
        seerrEmail = seerrAuth.email;
        jellyfinUserId = seerrAuth.jellyfinUserId ?? '';
        jellyfinUsername = seerrAuth.displayName ?? username;
        if (jellyfinUserId && jellyfinClient.isConfigured && typeof jellyfinClient.getUserById === 'function') {
          const jfUser = await jellyfinClient.getUserById(jellyfinUserId);
          if (jfUser.Id && jfUser.Id !== jellyfinUserId) throw new Error('The verified Jellyfin identity did not match.');
          isAdmin = jfUser.Policy?.IsAdministrator === true;
        }
      } else if (jellyfinClient.isConfigured) {
        const authResult = await jellyfinClient.authenticateUser(username, password);
        if (!authResult?.User?.Id) throw new Error('The service returned an invalid verified user id.');
        jellyfinUserId = authResult.User.Id;
        jellyfinUsername = authResult.User.Name || username;
        isAdmin = authResult.User.Policy?.IsAdministrator === true;
      } else {
        await FlowHandler.clearSession(ctx.senderId, 'media_connect', ctx.platform, ctx.chatId);
        await ctx.reply(t(ctx.language, 'media.not_configured') || '❌ Media services are not configured. Please contact the bot admin.');
        return;
      }

      if (!jellyfinUserId && seerrUserId === undefined) throw new Error('No verified service identity was returned.');
      const metadata = JSON.stringify({ isAdmin, seerrUserId, verified: true, verifiedAt: new Date().toISOString(), authMethod: seerrUserId !== undefined ? 'jellyfin-via-seerr' : 'jellyfin' });
      let bound = 0;
      if (jellyfinUserId) {
        await MediaService.bindingService.bind({ userId: ctx.senderId, platform: ctx.platform, serviceType: 'jellyfin', externalUserId: jellyfinUserId, externalUsername: jellyfinUsername || username, externalEmail: seerrEmail, metadata });
        bound++;
      }
      if (seerrUserId !== undefined) {
        await MediaService.bindingService.bind({ userId: ctx.senderId, platform: ctx.platform, serviceType: 'seerr', externalUserId: String(seerrUserId), externalUsername: jellyfinUsername || username, externalEmail: seerrEmail, metadata });
        bound++;
      }
      if (bound === 0) throw new Error('No verified service binding could be created.');

      await FlowHandler.clearSession(ctx.senderId, 'media_connect', ctx.platform, ctx.chatId);

      const adminLabel = isAdmin ? ' 👑 ' : '';
      const adminText = adminLabel + (isAdmin ? t(ctx.language, 'media.admin_label') || '(Admin)' : '');
      await ctx.reply(
        `${t(ctx.language, 'media.connected') || '✅ Account linked successfully!'}${adminText}\n` +
        `${t(ctx.language, 'media.connected_username') || 'Username:'} ${jellyfinUsername ?? username}\n\n` +
        `${t(ctx.language, 'media.notify_hint') || 'Would you like to receive media notifications in this chat? Use the notify command to manage notification preferences.'}`,
      );
    } catch (err: unknown) {
      await FlowHandler.clearSession(ctx.senderId, 'media_connect', ctx.platform, ctx.chatId);
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
  override readonly noArgAliases = ['connect', 'disconnect', 'notify'];
  override readonly dmOnlyAliases = ['connect'];
  override readonly mutability = 'external-mutation' as const;
  override readonly requiresBinding: boolean = false;
  override readonly commandGrammar: ToolCommandGrammar = {
    discriminator: 'action',
    variants: [
      { value: 'connect', arguments: [] },
      { value: 'disconnect', arguments: [] },
      { value: 'notify', arguments: [{ name: 'notify_action', kind: 'string' }, { name: 'room_id', kind: 'string' }] },
      { value: 'status', arguments: [] },
    ],
  };

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
    if (ctx.isGroup) return '❌ Media account linking is only available in a direct message.';
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
    await FlowHandler.setSession(
      ctx.senderId,
      'media_connect',
      { flow: 'media_connect', step: 'username', data: {}, roomId: ctx.chatId },
      ctx.platform,
      120,
      ctx.chatId,
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
    const currentRoom = ctx.chatId;
    const currentRoomKey = getCanonicalRoomKey(ctx);
    const requestedRoom = args.room_id?.trim();
    let foreignAuthorized = false;
    const isForeignRoom = requestedRoom ? !isCurrentRoom(ctx, requestedRoom) : false;

    if ((notifyAction === 'add' || notifyAction === 'remove') && !requestedRoom) {
      return notifyAction === 'add'
        ? (t(ctx.language, 'media.notify_add_prompt') || 'Please specify a room ID.')
        : (t(ctx.language, 'media.notify_not_found') || 'No notification subscription found for that room.');
    }

    if (requestedRoom && isForeignRoom) {
      const authorized = await authorizeNotificationDestination(ctx as NotificationDestinationContext, requestedRoom);
      foreignAuthorized = authorized;
      if (!authorized) return '❌ Foreign notification rooms require owner permission and verified platform membership.';
    }

    const roomId = requestedRoom || currentRoom;
    switch (notifyAction) {
      case 'here':
      case 'add':
        await MediaService.notificationService.subscribe({
          userId: ctx.senderId,
          platform: ctx.platform,
          serviceType: 'all',
          chatRoomId: roomId,
          roomKey: isCurrentRoom(ctx, roomId) ? currentRoomKey : toRoomKey(ctx.platform, roomId),
          currentRoomId: currentRoom,
          currentRoomKey,
          isOwner: isForeignRoom && await ctx.checkPermissions('owner'),
          roomVerified: foreignAuthorized || !isForeignRoom,
        });
        return notifyAction === 'here'
          ? (t(ctx.language, 'media.notify_here') || '✅ This chat will now receive media notifications.')
          : (t(ctx.language, 'media.notify_added', { room: roomId }) || `✅ Room ${roomId} will now receive media notifications.`);
      case 'remove': {
        const removed = await MediaService.notificationService.unsubscribe(ctx.senderId, ctx.platform, 'all', roomId, {
          currentRoomId: currentRoom,
          currentRoomKey,
          isOwner: isForeignRoom && await ctx.checkPermissions('owner'),
          roomVerified: foreignAuthorized || !isForeignRoom,
        });
        return removed
          ? (t(ctx.language, 'media.notify_removed', { room: roomId }) || `✅ Room ${roomId} will no longer receive media notifications.`)
          : (t(ctx.language, 'media.notify_not_found') || 'No notification subscription found for that room.');
      }
      case 'list': {
        const subs = await MediaService.notificationService.getSubscriptions(ctx.senderId, ctx.platform);
        const owner = await ctx.checkPermissions('owner');
        const visibleSubs = [];
        for (const [index, sub] of subs.entries()) {
          if (isCurrentRoom(ctx, sub.chatRoomId) || isSameRoom(ctx.platform, sub.roomKey, currentRoomKey)) {
            visibleSubs.push({ sub, index });
            continue;
          }
          const verifier = (ctx as NotificationDestinationContext).verifyRoomMembership;
          if (owner && typeof verifier === 'function' && await verifier(sub.chatRoomId, ctx.platform)) visibleSubs.push({ sub, index });
        }
        if (visibleSubs.length === 0) return t(ctx.language, 'media.notify_list_empty') || 'You have no notification subscriptions.';
        const lines = visibleSubs.map(({ sub, index }) => {
          let types = t(ctx.language, 'media.notify_types_all') || 'all';
          if (sub.notifyTypes) {
            try {
              const parsed = JSON.parse(sub.notifyTypes);
              if (Array.isArray(parsed) && parsed.length > 0) types = parsed.join(', ');
            } catch {
              types = t(ctx.language, 'media.notify_types_all') || 'all';
            }
          }
          return ` • ${sub.chatRoomId} (${sub.serviceType}) — ${types} (ID: ${index + 1})`;
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
    const owner = await ctx.checkPermissions('owner');
    const verifier = (ctx as NotificationDestinationContext).verifyRoomMembership;
    const visibleSubs = [];
    for (const sub of subs) {
      if (isCurrentRoom(ctx, sub.chatRoomId) || isSameRoom(ctx.platform, sub.roomKey, getCanonicalRoomKey(ctx)) || (owner && typeof verifier === 'function' && await verifier(sub.chatRoomId, ctx.platform))) visibleSubs.push(sub);
    }
    const subLines = visibleSubs.length > 0
      ? visibleSubs.map((s) => ` • ${s.chatRoomId} (${s.serviceType})`).join('\n\n')
      : '_None_';

    return `${t(ctx.language, 'media.status_header') || '📋 *Linked Accounts:*'}\n${lines.join('\n\n')}\n\n${t(ctx.language, 'media.status_notify_header') || '📬 *Notification Rooms:*'}\n${subLines}`;
  }
}
