/**
 * @file src/providers/discord.ts
 * @description Discord messaging provider for ElastraX, built on top of discord.js.
 *
 * Responsibilities:
 *  - Initialise the Discord.js `Client` with the required Gateway intents (guild messages,
 *    DMs, message content) and log in using `DISCORD_BOT_TOKEN` from the environment.
 *  - Skip startup gracefully when the token is absent or set to the placeholder value
 *    `dummy_token_here` (so WhatsApp-only deployments work without a Discord token).
 *  - For every `messageCreate` event (excluding bot messages), build a normalised
 *    `MessageContext` and forward it to the registered message handler.
 *  - Download and cache Discord attachment media synchronously during context creation
 *    (Discord CDN links are stable, unlike WhatsApp's time-limited URLs).
 *  - Implement platform-specific action methods: `reply`, `react`, `sendMedia`,
 *    `sendSticker`, `deleteMessage`, `updateGroupParticipants`, `checkPermissions`.
 *
 * Notes:
 *  - `mediaReady` resolves immediately for Discord because downloads are synchronous
 *    inside `createContext` (no background-download pattern needed).
 *  - Group admin operations map WhatsApp semantics ("remove") to Discord guild kicks.
 *    Adding members requires OAuth2 and is intentionally unsupported.
 */

import { Client, GatewayIntentBits, Partials, Message as DiscordMessage, AttachmentBuilder, PermissionsBitField } from 'discord.js';
import { BotProvider } from './BotProvider';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';
import { RoleService } from '../utils/RoleService';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { fileTypeFromBuffer } from 'file-type';

/** Maximum file size in bytes for Discord attachments that the bot will download (200 MB). */
const MAX_MEDIA_SIZE = 200 * 1024 * 1024; // 200MB

/**
 * Discord platform provider.  Implements the `BotProvider` interface and manages
 * the discord.js `Client` lifecycle from login to graceful shutdown.
 */
export class DiscordProvider implements BotProvider {
  name = 'discord' as const;
  private client: Client | null = null;
  private messageHandler: ((ctx: MessageContext) => Promise<void>) | null = null;

  /**
   * Logs in to Discord using `DISCORD_BOT_TOKEN`.
   * Skips startup without error when the token is missing or is the placeholder value,
   * so a WhatsApp-only deployment does not require a Discord token.
   */
  async start(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token || token === 'dummy_token_here') {
      logger.warn('[Discord] DISCORD_BOT_TOKEN is missing or is dummy. Discord provider will not start.');
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.on('ready', () => {
      logger.info(`[Discord] Logged in as ${this.client?.user?.tag}!`);
    });

    this.client.on('messageCreate', async (msg: DiscordMessage) => {
      if (msg.author.bot) return;

      if (this.messageHandler) {
        const ctx = await this.createContext(msg);
        if (ctx) {
          await this.messageHandler(ctx);
        }
      }
    });

    try {
      await this.client.login(token);
    } catch (e: any) {
      logger.error(e, '[Discord] Failed to log in.');
    }
  }

  /** Destroys the Discord.js client and closes the WebSocket connection. */
  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      logger.info('[Discord] Disconnected.');
    }
  }

  /** Register the application-level callback that will receive every parsed MessageContext. */
  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error('Discord client is not initialized.');
    }
    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel ${chatId} is not text-based or not accessible.`);
    }
    await (channel as any).send(text);
  }

  /**
   * Converts a Discord.js `Message` into the normalised `MessageContext`.
   *
   * Downloads any attachments synchronously before returning, so `ctx.mediaPath`
   * is immediately available (unlike the WhatsApp provider which uses a background promise).
   *
   * @param msg - Raw Discord.js Message object.
   * @returns   Populated `MessageContext`, or `null` if the message cannot be processed.
   */
  private async createContext(msg: DiscordMessage): Promise<MessageContext | null> {
    const isGroup = !msg.channel.isDMBased();
    const mentionedIds = Array.from(msg.mentions.users.keys());
    
    const hasMedia = msg.attachments.size > 0;
    
    let quoted: MessageContext['quoted'] = undefined;
    if (msg.reference && msg.reference.messageId) {
      try {
        const fetchMsg = await msg.channel.messages.fetch(msg.reference.messageId);
        if (fetchMsg) {
          const isFromBot = fetchMsg.author.id === this.client?.user?.id;
          quoted = {
            messageType: fetchMsg.attachments.size > 0 ? 'document' : 'conversation',
            body: fetchMsg.content,
            text: fetchMsg.content,
            senderId: fetchMsg.author.id,
            hasMedia: fetchMsg.attachments.size > 0,
            stanzaId: fetchMsg.id,
            rawMessage: Object.assign(fetchMsg, { key: { fromMe: isFromBot } }),
          };
        }
      } catch (e) {
        logger.warn('Failed to fetch Discord quoted message');
      }
    }

    const downloadMediaFn = async (messageToUse: DiscordMessage): Promise<Buffer | null> => {
      const attachment = messageToUse.attachments.first();
      if (!attachment) return null;

      if (attachment.size > MAX_MEDIA_SIZE) {
        logger.warn({ size: attachment.size, max: MAX_MEDIA_SIZE }, '[Discord] Skipped large media download');
        return null;
      }

      try {
        const res = await fetch(attachment.url);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const arrayBuffer = await res.arrayBuffer();
        return Buffer.from(arrayBuffer);
      } catch (err) {
        logger.error(err, 'Failed to download Discord media');
        return null;
      }
    };

    let mediaPath: string | undefined;
    let mimeType: string | undefined;

    const saveBuffer = async (buffer: Buffer): Promise<{ path: string, mime: string } | null> => {
      try {
        const typeInfo = await fileTypeFromBuffer(buffer);
        const mime = typeInfo?.mime || 'application/octet-stream';
        const ext = typeInfo?.ext || 'bin';
        const filename = `${randomUUID()}.${ext}`;
        const filepath = join('./data/media', filename);
        await writeFile(filepath, buffer);
        return { path: filepath, mime };
      } catch (err) {
        logger.error(err, 'Failed to save buffer to disk');
        return null;
      }
    };

    if (hasMedia) {
      const buffer = await downloadMediaFn(msg);
      if (buffer) {
        const saved = await saveBuffer(buffer);
        if (saved) {
          mediaPath = saved.path;
          mimeType = saved.mime;
        }
      }
    }

    if (quoted?.hasMedia) {
      const buffer = await downloadMediaFn(quoted.rawMessage as DiscordMessage);
      if (buffer) {
        const saved = await saveBuffer(buffer);
        if (saved) {
          quoted.mediaPath = saved.path;
          quoted.mimeType = saved.mime;
        }
      }
    }

    const downloadMedia = async (): Promise<Buffer | null> => {
      if (hasMedia) {
        return downloadMediaFn(msg);
      } else if (quoted?.hasMedia) {
        return downloadMediaFn(quoted.rawMessage as DiscordMessage);
      }
      return null;
    };

    return {
      platform: 'discord',
      receivedAt: Date.now(),
      messageId: msg.id,
      chatId: msg.channelId,
      senderId: msg.author.id,
      senderName: msg.author.username,
      text: msg.content,
      messageType: hasMedia ? 'document' : 'conversation',
      isGroup,
      mentionedIds,
      hasMedia,
      mediaPath,
      mimeType,
      mediaReady: Promise.resolve(),
      quoted,
      rawMessage: msg,
      downloadMedia,

      sendMedia: async (buffer: Buffer, options = {}) => {
        const attachment = new AttachmentBuilder(buffer, { name: options.filename ?? 'file' });
        await msg.reply({ files: [attachment], content: options.caption });
      },

      deleteMessage: async (_key?: any) => {
        try { await msg.delete(); } catch { /* already deleted or no permission */ }
      },

      forwardMessage: async (_targetJid: string, text?: string) => {
        // For Discord, we route to a channel by ID if the text is provided
        if (text && this.client) {
          try {
            const targetChannel = await this.client.channels.fetch(_targetJid);
            if (targetChannel && targetChannel.isTextBased()) {
              await (targetChannel as any).send(text);
            }
          } catch (e) {
            logger.warn({ _targetJid, e }, '[Discord] forwardMessage to channel failed');
          }
        }
      },

      reply: async (replyText: string) => {
        await msg.reply({ content: replyText });
      },
      react: async (emoji: string) => {
        try {
          await msg.react(emoji);
        } catch (e) {
          // Some emojis might not be supported natively without exact parsing, ignore safely
        }
      },
      sendSticker: async (buffer: Buffer) => {
        const attachment = new AttachmentBuilder(buffer, { name: 'sticker.webp' });
        await msg.reply({ files: [attachment] });
      },
      updateGroupParticipants: async (action: 'add' | 'remove' | 'promote' | 'demote', userIds: string[]) => {
        if (!isGroup || !msg.guild) throw new Error("Not inside a guild.");
        if (action === 'add') {
          throw new Error("Discord bots cannot add users to a guild arbitrarily without OAuth2 flow.");
        }
        if (action === 'promote' || action === 'demote') {
          throw new Error('Promote/demote is not supported on Discord via this adapter.');
        }
        for (const userId of userIds) {
          try {
            await msg.guild.members.kick(userId, 'Automated by ElastraX GroupAdmin wrapper');
          } catch (e) {
            logger.error({ userId }, 'Failed to kick Discord user');
          }
        }
      },
      checkPermissions: async (required: 'user' | 'admin' | 'owner') => {
        if (required === 'user') return true;

        if (process.env.BOT_OWNER_JID && msg.author.id === process.env.BOT_OWNER_JID) {
          return true;
        }

        const dbRole = await RoleService.getEffectiveRole(msg.author.id, msg.channelId);
        if (dbRole && RoleService.meetsRequirement(dbRole, required)) {
          return true;
        }

        if (!isGroup || !msg.guild) return false;
        const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
        if (!member) return false;
        if (required === 'owner') return msg.guild.ownerId === msg.author.id;
        if (required === 'admin') {
          return member.permissions.has(PermissionsBitField.Flags.Administrator) ||
                 member.permissions.has(PermissionsBitField.Flags.ManageGuild);
        }
        return false;
      },
    };
  }
}
