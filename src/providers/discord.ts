import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  type Message as DiscordMessage,
  type MessageMentionOptions,
} from 'discord.js';
import type { BotProviderStatus } from './BotProvider';
import type { BotProvider } from './BotProvider';
import { ProviderLifecycleError, ProviderOperationError, ProviderStartError } from './errors';
import { createLazyPromise, HARD_MEDIA_MAX_BYTES } from './media';
import { readMediaBuffer, saveMediaResponse } from '../utils/MediaStorage';
import { MessageContext, ReplyOptions, type MediaAttachmentDescriptor, type RawProviderMessage } from '../core/MessageContext';
import { logger } from '../utils/logger';
import { AuthService } from '../utils/AuthService';

export const DISCORD_TEXT_LIMIT = 2000;

type DiscordAttachment = {
  id: string;
  url: string;
  size: number;
  name?: string;
  contentType?: string | null;
};

type DiscordEditableMessage = {
  edit(payload: { content: string }): Promise<unknown>;
};

type DiscordTypingChannel = {
  sendTyping(): Promise<unknown>;
};

type AttachmentSource = {
  descriptor: MediaAttachmentDescriptor;
  attachment: DiscordAttachment;
};

export const discordProviderDeps = {
  createClient: () => new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  }),
  fetch: globalThis.fetch,
};

export function chunkDiscordText(text: string, limit = DISCORD_TEXT_LIMIT): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Discord chunk limit must be positive.');
  const characters = Array.from(text);
  if (characters.length === 0) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += limit) {
    let end = Math.min(offset + limit, characters.length);
    if (end < characters.length) {
      const searchStart = Math.max(offset + Math.floor(limit / 2), offset + 1);
      const boundary = characters.slice(searchStart, end);
      const lastBreak = boundary.lastIndexOf('\n');
      const lastSpace = boundary.lastIndexOf(' ');
      const breakAt = Math.max(lastBreak, lastSpace);
      if (breakAt >= 0) end = searchStart + breakAt + 1;
    }
    chunks.push(characters.slice(offset, end).join(''));
  }
  return chunks;
}

export class DiscordProvider implements BotProvider {
  readonly name = 'discord' as const;
  private client: Client | null = null;
  private messageHandler: ((ctx: MessageContext) => Promise<void>) | null = null;
  private providerStatus: BotProviderStatus = 'stopped';
  private providerError: Error | null = null;
  private generation = 0;
  private startPromise: Promise<void> | null = null;
  private readonly mediaControllers = new Set<AbortController>();

  get status(): BotProviderStatus {
    return this.providerStatus;
  }

  get lastError(): Error | null {
    return this.providerError;
  }

  get isOperational(): boolean {
    return this.providerStatus === 'running';
  }

  async start(): Promise<void> {
    if (this.isOperational) return;
    if (this.startPromise && this.providerStatus === 'starting') return this.startPromise;
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token || token === 'dummy_token_here') {
      this.providerStatus = 'not_configured';
      this.providerError = null;
      logger.warn('[Discord] DISCORD_BOT_TOKEN is missing or is dummy. Discord provider is not operational.');
      return;
    }
    const generation = ++this.generation;
    this.providerStatus = 'starting';
    this.providerError = null;
    const run = this.startForGeneration(token, generation);
    this.startPromise = run;
    try {
      await run;
    } finally {
      if (this.startPromise === run) this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    this.providerStatus = 'stopped';
    for (const controller of this.mediaControllers) controller.abort(new ProviderLifecycleError('discord', 'media download'));
    this.mediaControllers.clear();
    const client = this.client;
    this.client = null;
    if (client) {
      client.destroy();
      logger.info('[Discord] Disconnected.');
    }
  }

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const client = this.client;
    if (!client || this.providerStatus !== 'running') throw new ProviderLifecycleError('discord', 'sendMessage');
    try {
      const channel = await client.channels.fetch(chatId);
      if (!channel?.isTextBased() || !('send' in channel) || typeof channel.send !== 'function') {
        throw new Error(`Discord channel ${chatId} is not text-based or cannot send messages.`);
      }
      for (const chunk of chunkDiscordText(text)) {
        signal?.throwIfAborted();
        await channel.send({ content: chunk, allowedMentions: { parse: [] } });
      }
    } catch (error) {
      throw new ProviderOperationError('discord', 'sendMessage', `Discord sendMessage failed: ${errorMessage(error)}`, error);
    }
  }

  private async startForGeneration(token: string, generation: number): Promise<void> {
    const client = discordProviderDeps.createClient();
    this.client = client;
    client.on('ready', () => {
      if (this.client !== client || generation !== this.generation) return;
      this.providerStatus = 'running';
      logger.info(`[Discord] Logged in as ${client.user?.tag ?? 'unknown'}.`);
    });
    client.on('error', error => {
      if (this.client !== client) return;
      this.providerStatus = 'error';
      this.providerError = error instanceof Error ? error : new Error(String(error));
      logger.error({ err: error }, '[Discord] Client error');
    });
    client.on('messageCreate', async (message: DiscordMessage) => {
      if (this.client !== client || generation !== this.generation || message.author.bot) return;
      try {
        if (!this.messageHandler) return;
        const ctx = await this.createContext(message, generation);
        if (ctx) await this.messageHandler(ctx);
      } catch (error) {
        logger.error({ err: error, msgId: message.id }, '[Discord] Unhandled messageCreate error');
      }
    });
    try {
      await client.login(token);
      if (this.client !== client || generation !== this.generation) {
        client.destroy();
        return;
      }
      this.providerStatus = 'running';
    } catch (error) {
      if (this.client === client) this.client = null;
      client.destroy();
      if (generation !== this.generation || this.providerStatus === 'stopped') return;
      this.providerStatus = 'error';
      this.providerError = error instanceof Error ? error : new Error(String(error));
      throw new ProviderStartError('discord', `Discord login failed: ${errorMessage(error)}`, error);
    }
  }

  private async createContext(msg: DiscordMessage, generation = this.generation): Promise<MessageContext | null> {
    const client = this.client;
    if (!client || generation !== this.generation) return null;
    const isGroup = !msg.channel.isDMBased();
    const mentionedIds = Array.from(msg.mentions.users.keys());
    const isBotMentioned = !!client.user?.id && msg.mentions.users.has(client.user.id);
    const currentSources = attachmentSources(msg, 'current', msg.id);
    const hasMedia = currentSources.length > 0;

    let quoted: MessageContext['quoted'];
    let quotedSources: AttachmentSource[] = [];
    if (msg.reference?.messageId) {
      try {
        const fetched = await msg.channel.messages.fetch(msg.reference.messageId);
        if (fetched) {
          quotedSources = attachmentSources(fetched, 'quoted', fetched.id);
          const isFromBot = fetched.author.id === client.user?.id;
          quoted = {
            messageType: descriptorMessageType(quotedSources, fetched.content ? 'conversation' : 'unknown'),
            body: fetched.content,
            text: fetched.content,
            senderId: fetched.author.id,
            hasMedia: quotedSources.length > 0,
            stanzaId: fetched.id,
            rawMessage: {
              key: {
                fromMe: isFromBot,
                id: fetched.id,
                remoteJid: msg.channelId,
              },
            } as RawProviderMessage,
          };
        }
      } catch (error) {
        logger.warn({ err: error }, '[Discord] Failed to fetch quoted message');
      }
    }

    const allSources = [...currentSources, ...quotedSources];
    const descriptors = allSources.map(source => source.descriptor);
    const sourcesById = new Map(allSources.map(source => [source.descriptor.id, source]));
    const defaultDescriptor = currentSources[0]?.descriptor ?? quotedSources[0]?.descriptor;
    let selectedAttachmentId = defaultDescriptor?.id;
    let mediaPath: string | undefined;
    let mimeType = defaultDescriptor?.mimeType;

    const updateSelected = (descriptor: MediaAttachmentDescriptor) => {
      selectedAttachmentId = descriptor.id;
      mediaPath = descriptor.mediaPath;
      mimeType = descriptor.mimeType;
      if (descriptor.origin === 'quoted' && descriptor.index === 0 && quoted) {
        quoted.mediaPath = descriptor.mediaPath;
        quoted.mimeType = descriptor.mimeType;
      }
    };

    const downloadDescriptor = async (descriptor: MediaAttachmentDescriptor, throwOnFailure: boolean): Promise<MediaAttachmentDescriptor | null> => {
      if (descriptor.state === 'ready' && descriptor.mediaPath) return descriptor;
      if (descriptor.state === 'skipped') {
        if (throwOnFailure) throw new ProviderOperationError('discord', 'downloadMedia', descriptor.error || 'Discord attachment is unavailable.');
        return null;
      }
      const source = sourcesById.get(descriptor.id);
      if (!source) return null;
      const controller = new AbortController();
      this.mediaControllers.add(controller);
      try {
        validateDiscordMediaUrl(source.attachment.url);
        const response = await discordProviderDeps.fetch(source.attachment.url, {
          redirect: 'error',
          signal: controller.signal,
        });
        const saved = await saveMediaResponse(response, {
          maxBytes: HARD_MEDIA_MAX_BYTES,
          contentLength: Number.isSafeInteger(source.attachment.size) ? source.attachment.size : null,
          fallbackMime: source.attachment.contentType || descriptor.mimeType,
          signal: controller.signal,
        });
        descriptor.mediaPath = saved.path;
        descriptor.mimeType = saved.mime;
        descriptor.state = 'ready';
        descriptor.error = undefined;
        if (selectedAttachmentId === descriptor.id) updateSelected(descriptor);
        return descriptor;
      } catch (error) {
        descriptor.state = 'error';
        descriptor.error = errorMessage(error).slice(0, 500);
        logger.warn({ attachmentId: descriptor.id, err: error }, '[Discord] Failed to download attachment');
        if (throwOnFailure) throw new ProviderOperationError('discord', 'downloadMedia', descriptor.error, error);
        return null;
      } finally {
        this.mediaControllers.delete(controller);
      }
    };

    const mediaReady = createLazyPromise(async () => {
      if (defaultDescriptor) await downloadDescriptor(defaultDescriptor, false);
    });

    const selectMediaAttachment = async (attachmentId: string): Promise<MediaAttachmentDescriptor> => {
      const descriptor = descriptors.find(candidate => candidate.id === attachmentId);
      if (!descriptor) throw new ProviderOperationError('discord', 'selectMediaAttachment', `Unknown Discord attachment: ${attachmentId}.`, undefined, 'INVALID_TARGET');
      const downloaded = await downloadDescriptor(descriptor, true);
      if (!downloaded) throw new ProviderOperationError('discord', 'selectMediaAttachment', 'Discord attachment could not be downloaded.');
      updateSelected(downloaded);
      return { ...downloaded };
    };

    const downloadMedia = async (attachmentId?: string): Promise<Buffer | null> => {
      const id = attachmentId ?? selectedAttachmentId;
      if (!id) return null;
      const descriptor = await selectMediaAttachment(id);
      return descriptor.mediaPath ? readMediaBuffer(descriptor.mediaPath) : null;
    };

    let rolesCache: string[] | null = null;
    const resolveRoles = async (): Promise<string[]> => {
      if (rolesCache) return rolesCache;
      let platformAdmin = false;
      if (isGroup && msg.guild) {
        const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
        platformAdmin = !!member && (
          member.permissions.has(PermissionsBitField.Flags.Administrator) ||
          member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
          msg.guild.ownerId === msg.author.id
        );
      }
      rolesCache = await AuthService.resolveRoles(msg.author.id, msg.channelId, platformAdmin, undefined, 'discord');
      return rolesCache;
    };

    const ensureCurrentGeneration = () => {
      if (this.client !== client || generation !== this.generation) throw new ProviderLifecycleError('discord', 'message action');
    };

    const sendToProvider = (targetChatId: string, text: string) => this.sendMessage(targetChatId, text);
    return {
      platform: 'discord',
      receivedAt: Date.now(),
      messageId: msg.id,
      chatId: msg.channelId,
      senderId: msg.author.id,
      senderName: msg.author.username,
      text: msg.content,
      messageType: descriptorMessageType(currentSources, 'conversation'),
      isGroup,
      mentionedIds,
      isBotMentioned,
      hasMedia,
      get mediaPath() { return mediaPath; },
      get mimeType() { return mimeType; },
      mediaReady,
      mediaAttachments: descriptors,
      get selectedAttachmentId() { return selectedAttachmentId; },
      selectMediaAttachment,
      getMediaAttachment: id => descriptors.find(descriptor => descriptor.id === id),
      quoted,
      rawMessage: msg as unknown as RawProviderMessage,
      downloadMedia,

      sendMedia: async (buffer: Buffer, options = {}) => {
        ensureCurrentGeneration();
        const filename = safeFilename(options.filename) || defaultMediaFilename(options.mimetype);
        const attachment = new AttachmentBuilder(buffer, {
          name: filename,
          description: options.durationSeconds ? `Audio duration: ${Math.max(0, Math.round(options.durationSeconds))} seconds` : undefined,
        });
        await msg.reply({
          files: [attachment],
          content: options.caption ? truncateDiscordText(options.caption) : undefined,
          allowedMentions: { parse: [] },
        });
      },

      deleteMessage: async (key?: unknown) => {
        ensureCurrentGeneration();
        try {
          const candidate = key as { delete?: () => Promise<unknown>; id?: unknown } | undefined;
          if (candidate && typeof candidate.delete === 'function') {
            await candidate.delete();
            return;
          }
          if (candidate && typeof candidate.id === 'string') {
            const fetched = await msg.channel.messages.fetch(candidate.id);
            await fetched.delete();
            return;
          }
          await msg.delete();
        } catch (error) {
          throw new ProviderOperationError('discord', 'deleteMessage', `Discord delete failed: ${errorMessage(error)}`, error);
        }
      },

      forwardMessage: async (targetJid: string, text?: string) => {
        ensureCurrentGeneration();
        try {
          const targetChannel = await client.channels.fetch(targetJid);
          if (!targetChannel?.isTextBased() || !('send' in targetChannel) || typeof targetChannel.send !== 'function') {
            throw new Error(`Discord target ${targetJid} is not a sendable text channel.`);
          }
          if (text !== undefined) {
            for (const chunk of chunkDiscordText(text)) {
              await targetChannel.send({ content: chunk, allowedMentions: { parse: [] } });
            }
            return;
          }
          const files = Array.from(msg.attachments.values(), attachment => attachment.url);
          await targetChannel.send({
            content: truncateDiscordText(msg.content || ''),
            ...(files.length > 0 ? { files } : {}),
            allowedMentions: { parse: [] },
          });
        } catch (error) {
          throw new ProviderOperationError('discord', 'forwardMessage', `Discord forward failed: ${errorMessage(error)}`, error);
        }
      },

      reply: async (replyText: string, options?: ReplyOptions) => {
        ensureCurrentGeneration();
        const chunks = chunkDiscordText(replyText);
        for (let index = 0; index < chunks.length; index++) {
          await msg.reply({
            content: chunks[index],
            allowedMentions: discordAllowedMentions(index === 0 ? options?.mentions : undefined),
          });
        }
      },

      sendTyping: async () => {
        if (msg.channel && hasSendTyping(msg.channel)) await msg.channel.sendTyping();
      },

      sendMessage: async (text: string, options?: ReplyOptions) => {
        ensureCurrentGeneration();
        if (!('send' in msg.channel) || typeof msg.channel.send !== 'function') {
          throw new ProviderOperationError('discord', 'sendMessage', 'Discord channel does not support sending messages.');
        }
        const chunks = chunkDiscordText(text);
        let sent: unknown;
        for (let index = 0; index < chunks.length; index++) {
          options?.signal?.throwIfAborted();
          sent = await msg.channel.send({
            content: chunks[index],
            allowedMentions: discordAllowedMentions(index === 0 ? options?.mentions : undefined),
          });
        }
        return sent;
      },

      sendToChat: async (targetChatId: string, text: string, options?: ReplyOptions) => {
        ensureCurrentGeneration();
        options?.signal?.throwIfAborted();
        return sendToProvider(targetChatId, text);
      },

      editMessage: async (key: unknown, text: string) => {
        ensureCurrentGeneration();
        if (!isEditableMessage(key)) throw new ProviderOperationError('discord', 'editMessage', 'Invalid Discord message handle.', undefined, 'INVALID_TARGET');
        await key.edit({ content: truncateDiscordText(text), allowedMentions: { parse: [], users: [] } } as unknown as { content: string });
      },

      react: async (emoji: string) => {
        ensureCurrentGeneration();
        await msg.react(emoji);
      },

      sendSticker: async (buffer: Buffer) => {
        ensureCurrentGeneration();
        await msg.reply({ files: [new AttachmentBuilder(buffer, { name: 'sticker.webp' })], allowedMentions: { parse: [] } });
      },

      updateGroupParticipants: async (action, userIds) => {
        ensureCurrentGeneration();
        if (!isGroup || !msg.guild) throw new ProviderOperationError('discord', 'updateGroupParticipants', 'Not inside a Discord guild.');
        if (action === 'add') throw new ProviderOperationError('discord', 'updateGroupParticipants', 'Discord does not support adding arbitrary guild members through this adapter.', undefined, 'UNSUPPORTED');
        if (action === 'promote' || action === 'demote') throw new ProviderOperationError('discord', 'updateGroupParticipants', 'Discord promote/demote is not supported by this adapter.', undefined, 'UNSUPPORTED');
        const results = await Promise.allSettled(userIds.map(userId => msg.guild!.members.kick(userId, 'Automated by ElastraX GroupAdmin wrapper')));
        const failures = results.filter(result => result.status === 'rejected');
        if (failures.length > 0) {
          throw new ProviderOperationError('discord', 'updateGroupParticipants', `Failed to kick ${failures.length} of ${userIds.length} Discord users.`, new AggregateError(failures.map(failure => failure.reason)));
        }
      },

      checkPermissions: async (required: string) => required === 'user' || AuthService.hasPermission(await resolveRoles(), required),
      resolveRoles,
    };
  }
}

function attachmentSources(message: DiscordMessage, origin: 'current' | 'quoted', providerParentId: string): AttachmentSource[] {
  return Array.from(message.attachments.values()).map((value, index) => {
    const attachment = value as unknown as DiscordAttachment;
    const descriptor: MediaAttachmentDescriptor = {
      id: `${origin}:${providerParentId}:${attachment.id || index}`,
      index,
      origin,
      providerId: attachment.id,
      filename: attachment.name,
      mimeType: attachment.contentType || undefined,
      sizeBytes: Number.isSafeInteger(attachment.size) ? attachment.size : undefined,
      state: attachment.size > HARD_MEDIA_MAX_BYTES ? 'skipped' : 'pending',
      error: attachment.size > HARD_MEDIA_MAX_BYTES ? `Discord attachment exceeds ${HARD_MEDIA_MAX_BYTES} bytes.` : undefined,
    };
    return { descriptor, attachment };
  });
}

function descriptorMessageType(sources: AttachmentSource[], fallback: string): string {
  const mime = sources[0]?.attachment.contentType?.toLowerCase() || '';
  if (mime.startsWith('image/')) return 'imageMessage';
  if (mime.startsWith('video/')) return 'videoMessage';
  if (mime.startsWith('audio/')) return 'audioMessage';
  return sources.length > 0 ? 'documentMessage' : fallback;
}

function discordAllowedMentions(users?: string[]): MessageMentionOptions {
  const validUsers = [...new Set((users || []).filter(user => /^\d{5,25}$/.test(user)))];
  return validUsers.length > 0 ? { parse: ['users'], users: validUsers } : { parse: [], users: [] };
}

function truncateDiscordText(text: string): string {
  const characters = Array.from(text);
  return characters.length <= DISCORD_TEXT_LIMIT ? text : characters.slice(0, DISCORD_TEXT_LIMIT).join('');
}

function validateDiscordMediaUrl(rawUrl: string): void {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Invalid Discord CDN URL protocol.');
  if (url.protocol !== 'https:') throw new Error('Discord CDN media must use HTTPS.');
  const hostname = url.hostname.toLowerCase();
  if (hostname !== 'discordapp.com' && hostname !== 'discordapp.net' && !hostname.endsWith('.discordapp.com') && !hostname.endsWith('.discordapp.net')) {
    throw new Error('Discord attachment URL is not on an allowed CDN host.');
  }
}

function defaultMediaFilename(mimeType?: string): string {
  const extensions: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
  };
  return `attachment.${extensions[mimeType || ''] || 'bin'}`;
}

function safeFilename(filename?: string): string | undefined {
  if (!filename) return undefined;
  const sanitized = Array.from(filename, character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || character === '/' || character === '\\' ? '_' : character;
  }).join('').slice(0, 200);
  return sanitized || undefined;
}

function hasSendTyping(channel: DiscordMessage['channel']): channel is DiscordMessage['channel'] & DiscordTypingChannel {
  return 'sendTyping' in channel && typeof channel.sendTyping === 'function';
}

function isEditableMessage(value: unknown): value is DiscordEditableMessage {
  return typeof value === 'object' && value !== null && 'edit' in value && typeof (value as { edit?: unknown }).edit === 'function';
}

function errorMessage(error: unknown): string {
  return sanitizeErrorText(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function sanitizeErrorText(text: string): string {
  return Array.from(text, character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  }).join('');
}
