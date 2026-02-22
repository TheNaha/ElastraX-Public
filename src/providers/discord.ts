import { Client, GatewayIntentBits, Partials, Message as DiscordMessage, AttachmentBuilder, PermissionsBitField } from 'discord.js';
import { BotProvider } from './BotProvider';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { fileTypeFromBuffer } from 'file-type';

export class DiscordProvider implements BotProvider {
  name = 'discord' as const;
  private client: Client | null = null;
  private messageHandler: ((ctx: MessageContext) => Promise<void>) | null = null;

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

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      logger.info('[Discord] Disconnected.');
    }
  }

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  private async createContext(msg: DiscordMessage): Promise<MessageContext | null> {
    const isGroup = !msg.channel.isDMBased();
    const mentionedIds = Array.from(msg.mentions.users.keys());
    
    const hasMedia = msg.attachments.size > 0;
    
    let quoted: MessageContext['quoted'] = undefined;
    if (msg.reference && msg.reference.messageId) {
      try {
        const fetchMsg = await msg.channel.messages.fetch(msg.reference.messageId);
        if (fetchMsg) {
          quoted = {
            rawMessage: fetchMsg,
            senderId: fetchMsg.author.id,
            text: fetchMsg.content,
            hasMedia: fetchMsg.attachments.size > 0,
          };
        }
      } catch (e) {
        logger.warn('Failed to fetch Discord quoted message');
      }
    }

    const downloadMediaFn = async (messageToUse: DiscordMessage): Promise<Buffer | null> => {
      const attachment = messageToUse.attachments.first();
      if (!attachment) return null;
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
      messageId: msg.id,
      chatId: msg.channelId,
      senderId: msg.author.id,
      senderName: msg.author.username,
      text: msg.content,
      isGroup,
      mentionedIds,
      hasMedia,
      mediaPath,
      mimeType,
      mediaReady: Promise.resolve(), // Discord has no background download — always ready
      quoted,
      rawMessage: msg,
      downloadMedia,
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
      updateGroupParticipants: async (action: 'add' | 'remove', userIds: string[]) => {
        if (!isGroup || !msg.guild) throw new Error("Not inside a guild.");
        if (action === 'add') {
          throw new Error("Discord bots cannot add users to a guild arbitrarily without OAuth2 flow.");
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
        if (!isGroup || !msg.guild) return false;
        
        const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
        if (!member) return false;

        if (required === 'owner') {
          return msg.guild.ownerId === msg.author.id;
        }

        if (required === 'admin') {
          return member.permissions.has(PermissionsBitField.Flags.Administrator) || member.permissions.has(PermissionsBitField.Flags.ManageGuild);
        }

        return false;
      },
    };
  }
}
