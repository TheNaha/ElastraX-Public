/**
 * @file src/providers/telegram.ts
 * @description Telegram Bot API provider.
 *
 * Implements the `BotProvider` contract on top of grammy. The parts worth
 * knowing about:
 *
 *  - `start()` resolves only once the bot has actually authenticated, so the
 *    runtime admits the provider only when it can really deliver. (The WhatsApp
 *    provider used to resolve while still `starting`, which dropped it from the
 *    sender registry on every boot.)
 *  - Owner is seeded from `BOT_OWNER_TELEGRAM_ID` on connect. Telegram user ids
 *    are numeric snowflakes, so `BOT_OWNER_JID` can never match one; without
 *    this a fresh Telegram deployment has no `owner` at all and every
 *    owner-only tool is unreachable.
 *  - Group administration is limited to what the Bot API actually offers:
 *    ban/unban for removal, restrict for muting, invite links and leaving.
 *    Telegram has no "add member" or "promote/demote" concept for bots, so those
 *    report UNSUPPORTED rather than pretending.
 */
import {
  API_CONSTANTS,
  Bot,
  InputFile,
  type Bot as GrammyBot,
  type Context as GrammyContext,
} from 'grammy';
import { BotProvider, type BotProviderStatus } from './BotProvider';
import { MessageContext, type PlatformName } from '../core/MessageContext';
import { ProviderError, ProviderLifecycleError, ProviderOperationError } from './errors';
import { chunkTelegramText, TELEGRAM_TEXT_LIMIT } from './telegramText';
import { logger } from '../utils/logger';
import { AuthService } from '../utils/AuthService';
import { IdentityService } from '../utils/IdentityService';
import { saveMediaResponse, type SavedMedia } from '../utils/MediaStorage';
import { noteBotMessageSent, recordReactionFeedback } from '../utils/feedback';
import { getErrorMessage } from '../utils/errorUtils';

const log = logger.child({ module: 'Telegram' });

/** Largest media we will accept from Telegram, matching the shared hard cap. */
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Injectable seams so tests do not need a live bot token. */
export const telegramProviderDeps = {
  createBot: undefined as ((token: string) => GrammyBot) | undefined,
  download: undefined as ((url: string, signal?: AbortSignal) => Promise<Response>) | undefined,
};

type RawProviderMessage = Record<string, unknown>;

function isGroupChat(ctx: GrammyContext): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup' || ctx.chat?.type === 'channel';
}

function senderDisplayName(ctx: GrammyContext): string {
  const from = ctx.from;
  if (!from) return 'unknown';
  const parts = [from.first_name, from.last_name].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : from.username ?? String(from.id);
}

function senderHandle(ctx: GrammyContext): string {
  const from = ctx.from;
  if (!from) return '';
  return from.username ? `@${from.username}` : String(from.id);
}

/** Map a Telegram message to the shared messageType vocabulary. */
type MediaField = { file_id: string; mime_type?: string; file_size?: number; file_name?: string };
/** Structural view of a Telegram message: only the fields this provider reads. */
type MessageLike = MessageCarrier & {
  message_id: number;
  from?: { id: number; is_bot?: boolean };
  reply_to_message?: MessageLike;
};
type MessageCarrier = {
  msg?: MessageLike;
  text?: string;
  caption?: string;
  photo?: MediaField[];
  video?: MediaField;
  voice?: MediaField;
  audio?: MediaField;
  document?: MediaField;
  sticker?: MediaField;
  location?: unknown;
  contact?: unknown;
};

function messageTypeOf(ctx: MessageCarrier): string {
  if (ctx.photo) return 'imageMessage';
  if (ctx.video) return 'videoMessage';
  if (ctx.voice || ctx.audio) return 'audioMessage';
  if (ctx.sticker) return 'stickerMessage';
  if (ctx.document) return 'documentMessage';
  if (ctx.location) return 'locationMessage';
  if (ctx.contact) return 'contactMessage';
  return ctx.text ? 'conversation' : 'unknown';
}

function mediaOf(ctx: MessageCarrier): { fileId: string; mime?: string; size?: number; name?: string } | null {
  if (ctx.photo?.length) {
    // Telegram sends every photo in several sizes; the last is the largest.
    const largest = ctx.photo[ctx.photo.length - 1]!;
    return { fileId: largest.file_id, size: largest.file_size };
  }
  if (ctx.video) return { fileId: ctx.video.file_id, mime: ctx.video.mime_type, size: ctx.video.file_size };
  if (ctx.voice) return { fileId: ctx.voice.file_id, mime: ctx.voice.mime_type, size: ctx.voice.file_size };
  if (ctx.audio) return { fileId: ctx.audio.file_id, mime: ctx.audio.mime_type, size: ctx.audio.file_size };
  if (ctx.document) return { fileId: ctx.document.file_id, mime: ctx.document.mime_type, size: ctx.document.file_size, name: ctx.document.file_name ?? undefined };
  return null;
}

function defaultFilename(mime: string | undefined): string {
  if (mime?.includes('png')) return 'image.png';
  if (mime?.includes('jpeg') || mime?.includes('jpg')) return 'image.jpg';
  if (mime?.includes('webp')) return 'image.webp';
  if (mime?.includes('ogg')) return 'voice.ogg';
  if (mime?.includes('mp4')) return 'video.mp4';
  if (mime?.includes('pdf')) return 'document.pdf';
  return 'file.bin';
}

export class TelegramProvider implements BotProvider {
  readonly name: PlatformName = 'telegram';

  private bot: GrammyBot | null = null;
  private messageHandler: ((ctx: MessageContext) => Promise<void>) | null = null;
  private providerStatus: BotProviderStatus = 'stopped';
  private providerError: Error | null = null;
  private desiredRunning = false;
  private lifecycleGeneration = 0;
  private botUserId: string | null = null;
  private started: Promise<void> | null = null;

  get status(): BotProviderStatus {
    return this.providerStatus;
  }

  get lastError(): Error | null {
    return this.providerError;
  }

  get isOperational(): boolean {
    return this.providerStatus === 'running';
  }

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    if (this.isOperational) return;
    if (this.started && this.providerStatus === 'starting') return this.started;

    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
      // Not an error: a deployment may simply not run Telegram. Reported as a
      // status so readiness can explain the gap instead of failing to boot.
      this.providerStatus = 'not_configured';
      this.providerError = null;
      log.info('[Telegram] TELEGRAM_BOT_TOKEN is not set; provider disabled');
      return;
    }

    this.desiredRunning = true;
    this.providerStatus = 'starting';
    this.providerError = null;
    const generation = ++this.lifecycleGeneration;

    this.started = (async () => {
      const bot = (telegramProviderDeps.createBot ?? ((value: string) => new Bot(value)))(token);
      this.bot = bot;
      this.attachHandlers(bot, generation);

      // Resolve only after authentication, so the runtime never admits a
      // provider that cannot deliver.
      let resolveReady: () => void;
      let rejectReady: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const settleGuard = setTimeout(() => rejectReady(new ProviderLifecycleError('telegram', 'Timed out authenticating with the Telegram API.')), 30_000);
      settleGuard.unref?.();

      void bot.start({
        onStart: async info => {
          if (!this.isCurrent(bot, generation)) return;
          this.botUserId = String(info.id);
          await this.seedOwner(generation);
          if (!this.isCurrent(bot, generation)) return;
          this.providerStatus = 'running';
          this.providerError = null;
          log.info({ username: info.username }, '[Telegram] Bot connected');
          clearTimeout(settleGuard);
          resolveReady();
        },
        // Long polling blocks by design; the promise must never settle here.
      }).catch((error: unknown) => {
        clearTimeout(settleGuard);
        if (!this.isCurrent(bot, generation)) return;
        this.providerStatus = this.desiredRunning ? 'backoff' : 'stopped';
        this.providerError = error instanceof Error ? error : new Error(String(error));
        log.error({ err: error }, '[Telegram] Polling stopped');
        rejectReady(error);
      });
      await ready;
    })().finally(() => {
      this.started = null;
    });

    return this.started;
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    this.lifecycleGeneration += 1;
    const bot = this.bot;
    this.bot = null;
    this.botUserId = null;
    this.providerStatus = 'stopped';
    if (bot) {
      try {
        bot.stop();
      } catch (error) {
        log.debug({ err: error }, '[Telegram] stop threw');
      }
    }
  }

  async sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<unknown> {
    const bot = this.bot;
    if (!bot || !this.desiredRunning) throw new ProviderLifecycleError('telegram', 'Not connected to Telegram.');
    let last: unknown = null;
    for (const chunk of chunkTelegramText(text)) {
      signal?.throwIfAborted();
      // No parse_mode: the agent's text is plain, and unescaped Markdown would
      // either be rejected or shown literally.
      last = await bot.api.sendMessage(chatId, chunk);
      const id = (last as { message_id?: number } | null)?.message_id;
      if (typeof id === 'number') noteBotMessageSent('telegram', String(id));
    }
    return last;
  }

  private isCurrent(bot: GrammyBot, generation: number): boolean {
    return this.bot === bot && generation === this.lifecycleGeneration && this.desiredRunning;
  }

  private requireBot(action: string): GrammyBot {
    if (!this.bot || !this.desiredRunning) throw new ProviderLifecycleError('telegram', `Cannot ${action}: the Telegram provider is not running.`);
    return this.bot;
  }

  /**
   * Grant the configured Telegram owner the `owner` role on connect. Without
   * this the platform starts with no owner, so every owner-only tool and all
   * global role management are unreachable there.
   */
  private async seedOwner(generation: number): Promise<void> {
    const ownerId = AuthService.resolveOwnerId('telegram')?.trim();
    if (!ownerId) return;
    try {
      await IdentityService.upsertIdentity(ownerId, ownerId, undefined, 'telegram');
      if (!this.isCurrent(this.bot as GrammyBot, generation)) return;
      await AuthService.setRole(ownerId, 'owner', 'global', 'telegram', 'system:startup');
      log.info({ ownerId }, '[Telegram] Owner role seeded');
    } catch (error) {
      log.error({ err: error, ownerId }, '[Telegram] Failed to seed owner role');
    }
  }

  private attachHandlers(bot: GrammyBot, generation: number): void {
    bot.on('message', async ctx => {
      if (!this.isCurrent(bot, generation) || !this.messageHandler) return;
      if (ctx.from?.is_bot) return;
      try {
        const context = await this.createContext(ctx, generation);
        if (context) await this.messageHandler(context);
      } catch (error) {
        log.error({ err: error, chatId: ctx.chat?.id }, '[Telegram] Unhandled message error');
      }
    });

    bot.on('message_reaction', async ctx => {
      if (!this.isCurrent(bot, generation)) return;
      if (ctx.from?.is_bot) return;
      // A reaction update carries the reacted-to message id directly; ctx.msg is
      // narrowed to never by grammy for this update type.
      const reactedMessage = (ctx.msg ?? { message_id: ctx.messageReaction?.message_id ?? 0 }) as { message_id: number };
      if (!reactedMessage.message_id) return;
      try {
        // A grammy reaction update is a single object describing the new state,
        // not a list of added reactions.
        const reaction = ctx.messageReaction as { type?: string; emoji?: { text?: string } } | undefined;
        if (reaction?.type === 'emoji' && reaction.emoji?.text) {
          recordReactionFeedback({
            platform: 'telegram',
            chatRoomId: String(ctx.chat?.id ?? ''),
            messageId: String(reactedMessage.message_id),
            reaction: reaction.emoji.text,
            removed: false,
          });
        }
      } catch (error) {
        log.debug({ err: error }, '[Telegram] Failed to record reaction feedback');
      }
    });
  }

  /** Download a Telegram file to a stored media path. */
  private async downloadToStorage(ctx: GrammyContext): Promise<{ mediaPath: string; mime: string } | null> {
    const bot = this.requireBot('downloadMedia');
    const media = mediaOf(ctx);
    if (!media) return null;
    if (media.size && media.size > MAX_MEDIA_BYTES) {
      throw new ProviderOperationError('telegram', 'downloadMedia', `Attachment exceeds ${MAX_MEDIA_BYTES} bytes.`, undefined, 'UNSUPPORTED');
    }
    const file = await bot.api.getFile(media.fileId);
    if (!file.file_path) return null;

    const download = telegramProviderDeps.download ?? ((url: string, signal?: AbortSignal) => fetch(url, { signal }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await download(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN ?? ''}/${file.file_path}`, controller.signal);
      if (!response.ok) throw new ProviderOperationError('telegram', 'downloadMedia', `Download failed with status ${response.status}.`, undefined, 'OPERATION_FAILED');
      const mime = media.mime ?? guessMime(media.name);
      // Stream straight to disk rather than buffering: an attachment can be up
      // to 200 MB and the quota path already enforces the cap.
      const saved: SavedMedia = await saveMediaResponse(response, {
        maxBytes: MAX_MEDIA_BYTES,
        fallbackMime: mime,
        contentLength: media.size ?? null,
        signal: controller.signal,
      });
      return { mediaPath: saved.path, mime: saved.mime || mime };
    } finally {
      clearTimeout(timer);
    }
  }

  private async createContext(ctx: GrammyContext, generation: number): Promise<MessageContext | null> {
    const bot = this.bot;
    if (!bot || !this.isCurrent(bot, generation)) return null;
    const chatId = ctx.chat?.id;
    // grammy's base Context types `message` as optional; everything below needs it.
    const msg = ctx.message;
    if (chatId === undefined || !msg) return null;

    const isGroup = isGroupChat(ctx);
    const media = mediaOf(ctx as unknown as MessageCarrier);
    // Text that also carries media keeps the caption as the text; the media is
    // surfaced separately so the agent can see both.
    const text = msg.text ?? msg.caption ?? '';
    const botId = this.botUserId;
    const isBotMentioned = Boolean(
      (botId && text.includes(botId))
      || (ctx.me && text.includes(`@${ctx.me.username}`))
      || (isGroup && /\/[a-z_]+\b/.test(text)),
    );

    let mediaPath: string | undefined;
    let mimeType: string | undefined;
    const mediaReady = (async () => {
      if (!media) return;
      try {
        const saved = await this.downloadToStorage(ctx);
        mediaPath = saved?.mediaPath;
        mimeType = saved?.mime;
      } catch (error) {
        log.debug({ err: error }, '[Telegram] Media download failed');
      }
    })();

    let rolesPromise: Promise<string[]> | null = null;
    const resolveRoles = (): Promise<string[]> => {
      // Cached per message: the agent calls this from several places.
      rolesPromise ??= AuthService.resolveRoles(String(ctx.from?.id ?? ''), String(chatId), false, senderHandle(ctx), 'telegram');
      return rolesPromise;
    };

    const sendText = async (targetChatId: string, replyText: string): Promise<unknown> => {
      const activeBot = this.requireBot('reply');
      const replied = await activeBot.api.sendMessage(targetChatId, replyText, {
        reply_parameters: { message_id: msg.message_id },
      });
      const id = (replied as { message_id?: number } | null)?.message_id;
      if (typeof id === 'number') noteBotMessageSent('telegram', String(id));
      return replied;
    };

    const ensureCurrent = (): GrammyBot => {
      if (!this.isCurrent(this.bot as GrammyBot, generation)) {
        throw new ProviderLifecycleError('telegram', 'Cannot act on a message from a stopped Telegram generation.');
      }
      return this.bot as GrammyBot;
    };

    const context: MessageContext = {
      platform: 'telegram',
      receivedAt: Date.now(),
      messageId: String(msg.message_id),
      chatId: String(chatId),
      senderId: String(ctx.from?.id ?? ''),
      senderName: senderDisplayName(ctx),
      text,
      messageType: messageTypeOf(ctx),
      isGroup,
      isBotMentioned,
      hasMedia: Boolean(media),
      get mediaPath() { return mediaPath; },
      get mimeType() { return mimeType; },
      mediaReady,
      rawMessage: ctx.message as unknown as RawProviderMessage,
      downloadMedia: () => this.downloadToStorage(ctx),
      resolveRoles,
      checkPermissions: async required => (await resolveRoles()).includes('owner') || (await resolveRoles()).includes(required),
      reply: replyText => sendText(String(chatId), replyText),
      sendToChat: (targetChatId: string, replyText: string) => this.sendMessage(targetChatId, replyText),
      sendMessage: replyText => sendText(String(chatId), replyText),
      sendTyping: async () => {
        const activeBot = ensureCurrent();
        await activeBot.api.sendChatAction(chatId, 'typing');
      },
      react: async (emoji: string) => {
        const activeBot = ensureCurrent();
        const glyph = emoji.trim() || '\u{1F44D}';
        await activeBot.api.setMessageReaction(chatId, msg.message_id, [
          // grammy's type is a closed union of every reaction Telegram knows,
          // so an arbitrary glyph needs the cast.
          { type: 'emoji', emoji: glyph as '\u{1F44D}' },
        ]);
      },
      editMessage: async (key: unknown, nextText: string) => {
        const activeBot = ensureCurrent();
        const messageId = typeof key === 'object' && key !== null
          ? (key as { messageId?: number }).messageId
          : msg.message_id;
        // Telegram caps an edit at the message limit; fall back to sending the
        // remainder rather than silently truncating the answer.
        const head = nextText.slice(0, TELEGRAM_TEXT_LIMIT);
        await activeBot.api.editMessageText(chatId, messageId ?? msg.message_id, head);
        if (head.length < nextText.length) {
          const extra = await activeBot.api.sendMessage(chatId, nextText.slice(head.length));
          const id = (extra as { message_id?: number } | null)?.message_id;
          if (typeof id === 'number') noteBotMessageSent('telegram', String(id));
        }
      },
      sendMedia: async (buffer: Buffer, options = {}) => {
        const activeBot = ensureCurrent();
        const mime = options.mimetype ?? 'application/octet-stream';
        const filename = options.filename ?? defaultFilename(options.mimetype);
        // Telegram caps uploads at 50 MB; anything larger must be sent as a
        // document, which has a much higher limit.
        if (buffer.byteLength <= 50 * 1024 * 1024 && mime.startsWith('image/')) {
          const sent = await activeBot.api.sendPhoto(chatId, new InputFile(buffer), { caption: options.caption });
          noteBotMessageSent('telegram', sent.photo.at(-1)?.file_id ?? '');
          return;
        }
        if (buffer.byteLength <= 50 * 1024 * 1024 && mime.startsWith('audio/') && (options.ptt || mime.includes('ogg'))) {
          const sent = await activeBot.api.sendVoice(chatId, new InputFile(buffer), { caption: options.caption });
          noteBotMessageSent('telegram', sent.voice.file_id);
          return;
        }
        if (buffer.byteLength <= 50 * 1024 * 1024 && mime.startsWith('video/')) {
          const sent = await activeBot.api.sendVideo(chatId, new InputFile(buffer), { caption: options.caption });
          noteBotMessageSent('telegram', sent.video.file_id);
          return;
        }
        const sent = await activeBot.api.sendDocument(
          chatId,
          new InputFile(new Uint8Array(buffer), filename),
          options.caption ? { caption: options.caption } : {},
        );
        noteBotMessageSent('telegram', sent.document.file_id);
      },
      sendSticker: async (buffer: Buffer) => {
        const activeBot = ensureCurrent();
        const sent = await activeBot.api.sendSticker(chatId, new InputFile(buffer));
        noteBotMessageSent('telegram', sent.sticker.file_id);
      },
      deleteMessage: async (key?: unknown) => {
        const activeBot = ensureCurrent();
        const messageId = typeof key === 'object' && key !== null
          ? (key as { messageId?: number }).messageId
          : undefined;
        await activeBot.api.deleteMessage(chatId, messageId ?? msg.message_id);
      },
      forwardMessage: async (targetChatId: string, forwardText?: string) => {
        const activeBot = ensureCurrent();
        if (forwardText && forwardText.trim()) {
          await activeBot.api.sendMessage(targetChatId, forwardText);
          return;
        }
        // Telegram copies the message natively, so links and formatting survive.
        await activeBot.api.copyMessage(targetChatId, chatId, msg.message_id);
      },
      getGroupInviteLink: async () => {
        const activeBot = ensureCurrent();
        if (!isGroup) return undefined;
        return activeBot.api.exportChatInviteLink(chatId);
      },
      leaveGroup: async () => {
        const activeBot = ensureCurrent();
        if (!isGroup) return;
        await activeBot.api.leaveChat(chatId);
      },
      updateGroupParticipants: async (action: string, userIds: string[]) => {
        const activeBot = ensureCurrent();
        if (!isGroup) throw new ProviderOperationError('telegram', 'updateGroupParticipants', 'Not a group chat.', undefined, 'INVALID_TARGET');
        for (const rawId of userIds) {
          const userId = Number(rawId);
          if (!Number.isSafeInteger(userId)) {
            throw new ProviderOperationError('telegram', 'updateGroupParticipants', `"${rawId}" is not a Telegram user id.`, undefined, 'INVALID_TARGET');
          }
          if (action === 'remove' || action === 'kick') {
            // Telegram separates removal from muting; ban-then-unban is the
            // documented way to remove without blocking future re-joins.
            await activeBot.api.banChatMember(chatId, userId);
            await activeBot.api.unbanChatMember(chatId, userId).catch(() => undefined);
            continue;
          }
          if (action === 'mute') {
            await activeBot.api.restrictChatMember(chatId, userId, { can_send_messages: false });
            continue;
          }
          if (action === 'unmute') {
            await activeBot.api.restrictChatMember(chatId, userId, { ...API_CONSTANTS.ALL_CHAT_PERMISSIONS });
            continue;
          }
          throw new ProviderOperationError(
            'telegram', 'updateGroupParticipants',
            `Telegram bots cannot perform "${action}".`, undefined, 'UNSUPPORTED',
          );
        }
      },
      quoted: this.buildQuoted(ctx),
    } as MessageContext;

    return context;
  }

  /** Summarise the replied-to message, when there is one. */
  private buildQuoted(ctx: GrammyContext): MessageContext['quoted'] {
    const replyTo = ctx.msg?.reply_to_message;
    if (!replyTo) return undefined;
    const carrier = { ...ctx, msg: replyTo } as unknown as MessageCarrier;
    const media = mediaOf(carrier);
    const body = replyTo.text ?? replyTo.caption ?? '';
    return {
      messageType: messageTypeOf(carrier),
      body,
      text: body,
      senderId: String(replyTo.from?.id ?? ''),
      hasMedia: Boolean(media),
      stanzaId: String(replyTo.message_id),
      rawMessage: replyTo as unknown as RawProviderMessage,
    };
  }
}

function guessMime(name: string | undefined): string {
  if (!name) return 'application/octet-stream';
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.csv')) return 'text/csv';
  return 'application/octet-stream';
}

export { ProviderError, getErrorMessage };
