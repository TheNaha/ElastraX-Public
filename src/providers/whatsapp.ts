import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  type WAMessage,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { and, eq } from 'drizzle-orm';
import { noteBotMessageSent, recordReactionFeedback } from '../utils/feedback';
import type { BotProvider, BotProviderStatus } from './BotProvider';
import { ProviderLifecycleError, ProviderOperationError, ProviderStartError } from './errors';
import { createLazyPromise, HARD_MEDIA_MAX_BYTES } from './media';
import { getMessageMediaInfo, parseWhatsAppMessage, type WhatsAppMediaInfo } from './whatsappParser';
import {
  deleteSavedMedia,
  readMediaBuffer,
  saveMediaStream,
} from '../utils/MediaStorage';
import type {
  MediaAttachmentDescriptor,
  MessageContext,
  RawProviderMessage,
  ReplyOptions,
  SendMediaOptions,
} from '../core/MessageContext';
import { logger } from '../utils/logger';
import { checkPermissions, invalidateNativeAdminCache, resolveUserRoles } from '../utils/permissions';
import { useDBAuthState } from '../utils/useDBAuthState';
import { syncHistoricalDatabase } from '../utils/syncHistoricalDatabase';
import { db } from '../db';
import { messages } from '../db/schema';
import { IdentityService } from '../utils/IdentityService';
import { AuthService } from '../utils/AuthService';

type BaileysSocket = ReturnType<typeof makeWASocket>;
type SocketLogger = Parameters<typeof makeWASocket>[0]['logger'];
type MediaDownloadOptions = NonNullable<Parameters<typeof downloadMediaMessage>[3]>;
type SocketWithSignalRepository = BaileysSocket & {
  signalRepository?: {
    lidMapping?: {
      getLIDForPN(targetJid: string): Promise<string | null | undefined>;
    };
  };
};
type LidMapping = NonNullable<NonNullable<SocketWithSignalRepository['signalRepository']>['lidMapping']>;
/**
 * Baileys' event map is a wide union that does not include `messages.reaction`,
 * so the handler parameter is inferred as the whole union. These narrow it to
 * the fields this handler reads.
 */
/** `messages.reaction` delivers an array; `messages.reaction.update` is untyped. */
type WaReactionItem = { key?: WAMessage['key']; reaction?: string | { text?: string | null } | null };
type WaReactionUpdate = { key?: WAMessage['key']; reaction?: string; messages: WaReactionItem[] };

type ExtendedMessageKey = WAMessage['key'] & {
  // `participantAlt` is the real Baileys field carrying the sender's phone
  // number in group stanzas. The previous `participantPn`/`senderLid` members
  // did not exist on WAMessageKey, so they were always `undefined` at runtime
  // (TypeScript accepted the fabricated extension), which left `senderPn`
  // permanently empty for every group message.
  participantAlt?: string;
  remoteJidAlt?: string;
};
type ProviderMessageKey = proto.IMessageKey & {
  remoteJid?: string | null;
};
type MediaSource = {
  descriptor: MediaAttachmentDescriptor;
  message: WAMessage;
  info: WhatsAppMediaInfo;
};

export const WHATSAPP_TEXT_LIMIT = 65_536;

export function chunkWhatsAppText(text: string, limit = WHATSAPP_TEXT_LIMIT): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('WhatsApp chunk limit must be positive.');
  const characters = Array.from(text);
  if (characters.length === 0) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += limit) {
    chunks.push(characters.slice(offset, offset + limit).join(''));
  }
  return chunks;
}

export const whatsAppProviderDeps = {
  useAuthState: useDBAuthState,
  fetchLatestVersion: fetchLatestBaileysVersion,
  createSocket: (options: Parameters<typeof makeWASocket>[0]) => makeWASocket(options),
  renderQr: (qr: string) => qrcode.generate(qr, { small: true }),
  lookupStoredMessage: async (messageId: string, remoteJid?: string | null): Promise<string | null> => {
    // Scope the lookup to the conversation. WhatsApp message ids are unique per
    // chat, not globally, so an unscoped `provider_message_id` match could return
    // a different room's `raw_message` and splice it into this turn's context.
    // Scoping also lets SQLite use `messages_platform_provider_message_id_unique`
    // (platform, chat_room_id, provider_message_id) instead of scanning.
    if (!remoteJid) return null;
    const rows = await db
      .select({ rawMessage: messages.rawMessage })
      .from(messages)
      .where(and(
        eq(messages.platform, 'whatsapp'),
        eq(messages.chatRoomId, remoteJid),
        eq(messages.providerMessageId, messageId),
      ))
      .limit(1);
    return rows[0]?.rawMessage ?? null;
  },
};

export class WhatsAppProvider implements BotProvider {
  readonly name = 'whatsapp' as const;
  private sock: BaileysSocket | null = null;
  private messageHandler: ((ctx: MessageContext) => Promise<void>) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private desiredRunning = false;
  private generation = 0;
  private startPromise: Promise<void> | null = null;
  private providerStatus: BotProviderStatus = 'stopped';
  private providerError: Error | null = null;
  private botLid: string | null = null;
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

  private static botPnJid(userId: string): string {
    return `${userId.split(':')[0].split('@')[0]}@s.whatsapp.net`;
  }

  async start(): Promise<void> {
    this.desiredRunning = true;
    if (this.sock && (this.providerStatus === 'running' || this.providerStatus === 'starting')) return;
    const generation = ++this.generation;
    const run = this.startForGeneration(generation);
    this.startPromise = run;
    try {
      await run;
    } finally {
      if (this.startPromise === run) this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    this.generation++;
    this.providerStatus = 'stopped';
    this.providerError = null;
    for (const controller of this.mediaControllers) controller.abort(new ProviderLifecycleError('whatsapp', 'media download'));
    this.mediaControllers.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.sock;
    this.sock = null;
    this.botLid = null;
    sock?.end(new Error('Stop called'));
  }

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Turn raw reaction entries into feedback records. Reactions to messages the
   * bot did not send are dropped by the recorder itself, so this only has to
   * unwrap the platform shape.
   */
  private collectReactionFeedback(platform: string, entries: ReadonlyArray<WaReactionItem>): void {
    for (const entry of entries) {
      const key = entry.key;
      if (!key?.id) continue;
      try {
        recordReactionFeedback({
          platform,
          chatRoomId: key.remoteJid ?? '',
          messageId: key.id,
          reaction: typeof entry.reaction === 'string' ? entry.reaction : (entry.reaction?.text ?? ''),
          removed: false,
        });
      } catch (error) {
        logger.debug({ err: error }, '[WhatsApp] Failed to record reaction feedback');
      }
    }
  }

  async sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    const sock = this.requireRunningSocket('sendMessage');
    for (const chunk of chunkWhatsAppText(text)) {
      // Honour the signal between chunks. `AppRuntime.processOutbox` relies on
      // it to cancel a slow send; without this the underlying Baileys call kept
      // running and could still deliver after the outbox had already failed and
      // rescheduled the row, so the recipient got the message twice.
      signal?.throwIfAborted();
      const sent = await sock.sendMessage(chatId, { text: chunk });
      // Remember the id so a later reaction can be attributed to the bot.
      noteBotMessageSent('whatsapp', sent?.key?.id ?? null);
    }
  }

  private scheduleReconnect(generation: number): void {
    if (!this.desiredRunning || generation !== this.generation || this.reconnectTimer) return;
    const delay = Math.min(1500 * 2 ** this.reconnectAttempts, 300_000);
    this.reconnectAttempts++;
    this.providerStatus = 'backoff';
    logger.info({ delayMs: delay, attempt: this.reconnectAttempts }, '[WhatsApp] Scheduling reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.desiredRunning || generation !== this.generation) return;
      this.start().catch(error => {
        logger.error({ err: error }, '[WhatsApp] Reconnect start failed');
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async startForGeneration(generation: number): Promise<void> {
    this.providerStatus = 'starting';
    this.providerError = null;
    try {
      const { state, saveCreds } = await whatsAppProviderDeps.useAuthState();
      this.ensureGeneration(generation);
      const { version, isLatest } = await whatsAppProviderDeps.fetchLatestVersion();
      this.ensureGeneration(generation);
      const baileysLogger = logger.child({ module: 'baileys' });
      baileysLogger.level = 'warn';
      logger.info(`[WhatsApp] Using WA v${version.join('.')}, isLatest: ${isLatest}`);

      const existingSocket = this.sock;
      if (existingSocket) {
        this.sock = null;
        try {
          existingSocket.end(new Error('Restarting WhatsApp socket'));
        } catch (error) {
          logger.debug({ err: error }, '[WhatsApp] Existing socket close failed');
        }
      }

      const socket = whatsAppProviderDeps.createSocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: baileysLogger as unknown as SocketLogger,
        getMessage: async key => {
          if (!this.desiredRunning || generation !== this.generation || !key.id) return undefined;
          try {
            return extractStoredMessage(
              await whatsAppProviderDeps.lookupStoredMessage(key.id, key.remoteJid ?? null),
            );
          } catch (error) {
            logger.warn({ err: error, id: key.id }, '[WhatsApp] Failed to load message for retry');
            return undefined;
          }
        },
      });
      this.sock = socket;
      this.attachSocketHandlers(socket, saveCreds, generation);
    } catch (error) {
      if (!this.desiredRunning || generation !== this.generation) return;
      this.sock = null;
      this.botLid = null;
      this.providerStatus = 'backoff';
      this.providerError = error instanceof Error ? error : new Error(String(error));
      this.scheduleReconnect(generation);
      throw new ProviderStartError('whatsapp', `WhatsApp startup failed: ${errorMessage(error)}`, error);
    }
  }

  private attachSocketHandlers(
    socket: BaileysSocket,
    saveCreds: () => Promise<void>,
    generation: number,
  ): void {
    socket.ev.on('creds.update', () => {
      if (!this.isCurrent(socket, generation)) return;
      Promise.resolve(saveCreds()).catch(error => {
        this.providerError = error instanceof Error ? error : new Error(String(error));
        logger.error({ err: error }, '[WhatsApp] Failed to persist credentials');
      });
    });

    socket.ev.on('connection.update', async update => {
      if (!this.isCurrent(socket, generation)) return;
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        logger.info('[WhatsApp] Scan this QR code to login:');
        whatsAppProviderDeps.renderQr(qr);
      }
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut && this.desiredRunning && generation === this.generation;
        logger.warn({ err: lastDisconnect?.error, shouldReconnect }, '[WhatsApp] Connection closed');
        this.sock = null;
        this.botLid = null;
        this.providerError = lastDisconnect?.error instanceof Error ? lastDisconnect.error : null;
        this.providerStatus = shouldReconnect ? 'backoff' : statusCode === DisconnectReason.loggedOut ? 'error' : 'stopped';
        if (shouldReconnect) this.scheduleReconnect(generation);
      } else if (connection === 'open') {
        this.providerStatus = 'running';
        this.providerError = null;
        this.reconnectAttempts = 0;
        logger.info('[WhatsApp] Connected successfully.');
        if (socket.user?.id) {
          try {
            const botLid = await resolveLidForPn(socket, WhatsAppProvider.botPnJid(socket.user.id));
            if (!this.isCurrent(socket, generation)) return;
            this.botLid = botLid;
            if (botLid) logger.info({ botLid }, '[WhatsApp] Resolved bot LID');
          } catch (error) {
            logger.debug({ err: error }, '[WhatsApp] Could not resolve bot LID');
          }
        }
        if (!this.isCurrent(socket, generation)) return;
        await this.seedOwner(socket, generation);
      }
    });

    socket.ev.on('group-participants.update', update => {
      if (update.id) invalidateNativeAdminCache(update.id, 'whatsapp');
    });

    // Reactions on the bot's own replies are the cheapest quality signal
    // available. Recorded only when the reacted-to message is one the bot sent
    // recently, so a reaction to someone else's message is never attributed.
    socket.ev.on('messages.reaction', (entries: ReadonlyArray<WaReactionItem>) => {
      if (!this.isCurrent(socket, generation) || !Array.isArray(entries)) return;
      this.collectReactionFeedback('whatsapp', entries);
    });
    // `messages.reaction.update` fires when a reaction is edited; it is not in
    // Baileys' typed event map, so the name is cast rather than the whole chain.
    (socket.ev.on as (name: string, handler: (update: WaReactionUpdate) => void) => void)(
      'messages.reaction.update',
      update => {
        if (!this.isCurrent(socket, generation) || !Array.isArray(update?.messages)) return;
        this.collectReactionFeedback('whatsapp', update.messages);
      },
    );

    socket.ev.on('messages.upsert', async event => {
      if (!this.isCurrent(socket, generation) || event.type !== 'notify') return;
      await Promise.all(event.messages.map(async message => {
        if (!message.message || message.key.fromMe) return;
        if (!this.isCurrent(socket, generation) || !this.messageHandler) return;
        try {
          const ctx = await this.createContext(message, generation);
          if (ctx && this.isCurrent(socket, generation)) {
            await this.messageHandler(ctx);
            await socket.readMessages([message.key]);
          }
        } catch (error) {
          logger.error({ err: error, key: message.key }, '[WhatsApp] Error processing message');
        }
      }));
    });

    socket.ev.on('messaging-history.set', async event => {
      if (!this.isCurrent(socket, generation)) return;
      logger.info(`[WhatsApp] Received history sync with ${event.messages.length} messages.`);
      const contexts = (await Promise.all(event.messages.map(async message => {
        if (!message.message || message.key.fromMe) return null;
        try {
          return await this.createContext(message, generation, true);
        } catch {
          return null;
        }
      }))).filter((context): context is MessageContext => context !== null);
      if (this.isCurrent(socket, generation)) {
        syncHistoricalDatabase(contexts).catch(error => logger.error({ err: error }, 'Background history sync failed'));
      }
    });
  }

  private async seedOwner(socket: BaileysSocket, generation: number): Promise<void> {
    const ownerJid = process.env.BOT_OWNER_JID;
    if (!ownerJid) return;
    try {
      const ownerLid = await resolveLidForPn(socket, ownerJid);
      if (!this.isCurrent(socket, generation)) return;
      await IdentityService.upsertIdentity(ownerLid, ownerJid, undefined, 'whatsapp');
      if (!this.isCurrent(socket, generation)) return;
      const primaryId = ownerLid && ownerLid !== ownerJid ? ownerLid : ownerJid;
      await AuthService.setRole(primaryId, 'owner', 'global', 'whatsapp', 'system:startup');
      logger.info({ ownerJid, ownerLid }, '[WhatsApp] Owner role seeded');
    } catch (error) {
      logger.error({ err: error, ownerJid }, '[WhatsApp] Failed to seed owner role');
    }
  }

  private async createContext(
    message: WAMessage,
    generation: number = this.generation,
    skipMediaDownload = false,
  ): Promise<MessageContext | null> {
    const socket = this.sock;
    if (!socket || !this.desiredRunning || generation !== this.generation) return null;
    const jid = message.key.remoteJid;
    if (!jid) return null;
    if (!this.botLid && socket.user?.id) {
      try {
        const botLid = await resolveLidForPn(socket, WhatsAppProvider.botPnJid(socket.user.id));
        this.ensureSocket(socket, generation, 'createContext');
        this.botLid = botLid;
      } catch (error) {
        if (!this.isCurrent(socket, generation)) throw error;
        this.botLid = null;
      }
    }
    this.ensureSocket(socket, generation, 'createContext');

    const resolveLid = async (targetJid: string): Promise<string> => {
      if (!targetJid || targetJid.includes('@lid') || targetJid.includes('@g.us') || targetJid.includes('@broadcast')) return targetJid;
      try {
        return await resolveLidForPn(socket, targetJid) || targetJid;
      } catch {
        return targetJid;
      }
    };
    const parsed = await parseWhatsAppMessage(message, socket.user?.id, this.botLid, resolveLid);
    this.ensureSocket(socket, generation, 'createContext');
    const isGroup = jid.endsWith('@g.us');
    const key = message.key as ExtendedMessageKey;
    const rawSender = isGroup
      ? message.key.participant || message.key.remoteJid || jid
      // In a DM the remote jid *is* the partner. `key.senderLid` never existed on
      // WAMessageKey, so this always fell through to `jid`; `remoteJidAlt` is the
      // genuine alternative identity when the chat is addressed by LID.
      : key.remoteJidAlt || jid;
    const senderId = await resolveLid(rawSender);
    // Mirrors Baileys' own getKeyAuthor(): participantAlt holds the sender's
    // phone number in group stanzas, with the remaining key fields as fallbacks.
    const senderPn = isGroup
      ? key.participantAlt || key.remoteJidAlt || key.participant || undefined
      : (!senderId.includes('@lid') ? jid : key.remoteJidAlt);
    this.ensureSocket(socket, generation, 'createContext');

    let quoted: MessageContext['quoted'];
    let quotedSource: MediaSource | null = null;
    if (parsed.quoted) {
      const q = parsed.quoted;
      quotedSource = q.hasMedia ? {
        descriptor: {
          id: `quoted:${q.stanzaId || 'unknown'}`,
          index: 0,
          origin: 'quoted',
          providerId: q.stanzaId || undefined,
          mimeType: getMessageMediaInfo(q.rawMessage)?.mimeType,
          sizeBytes: getMessageMediaInfo(q.rawMessage)?.sizeBytes,
          state: q.hasMedia ? 'pending' : 'pending',
        },
        message: {
          key: {
            remoteJid: jid,
            fromMe: q.fromMe,
            id: q.stanzaId || undefined,
            participant: q.senderId,
          },
          message: q.rawMessage,
        } as WAMessage,
        info: getMessageMediaInfo(q.rawMessage) || {
          messageType: q.messageType,
          mimeType: undefined,
          fileName: undefined,
          sizeBytes: undefined,
          ptt: false,
        },
      } : null;
      quoted = {
        messageType: q.messageType,
        body: q.body,
        text: q.body,
        senderId: q.senderId,
        hasMedia: q.hasMedia,
        stanzaId: q.stanzaId || undefined,
        rawMessage: {
          key: quotedSource!.message.key as RawProviderMessage['key'],
          message: q.rawMessage as Record<string, unknown>,
        },
      };
    }

    const currentInfo = getMessageMediaInfo(message.message);
    const currentSource: MediaSource | null = currentInfo ? {
      descriptor: {
        id: `current:${message.key.id || 'unknown'}`,
        index: 0,
        origin: 'current',
        providerId: message.key.id || undefined,
        mimeType: currentInfo.mimeType,
        filename: currentInfo.fileName,
        sizeBytes: currentInfo.sizeBytes,
        state: currentInfo.sizeBytes && currentInfo.sizeBytes > HARD_MEDIA_MAX_BYTES ? 'skipped' : 'pending',
        error: currentInfo.sizeBytes && currentInfo.sizeBytes > HARD_MEDIA_MAX_BYTES ? `WhatsApp media exceeds ${HARD_MEDIA_MAX_BYTES} bytes.` : undefined,
      },
      message,
      info: currentInfo,
    } : null;
    const sources = [currentSource, quotedSource].filter((source): source is MediaSource => !!source);
    const descriptors = sources.map(source => source.descriptor);
    const sourceById = new Map(sources.map(source => [source.descriptor.id, source]));
    const defaultSource = currentSource || (!parsed.hasMedia ? quotedSource : null);
    let selectedAttachmentId = defaultSource?.descriptor.id;
    let mediaPath: string | undefined;
    let mimeType = defaultSource?.descriptor.mimeType;

    if (skipMediaDownload) {
      for (const descriptor of descriptors) {
        descriptor.state = 'skipped';
        descriptor.error = 'Historical media is loaded on demand.';
      }
    }

    const assertSocket = () => this.ensureSocket(socket, generation, 'message action');
    const updateSelected = (descriptor: MediaAttachmentDescriptor) => {
      selectedAttachmentId = descriptor.id;
      mediaPath = descriptor.mediaPath;
      mimeType = descriptor.mimeType;
      if (descriptor.origin === 'quoted' && quoted) {
        quoted.mediaPath = descriptor.mediaPath;
        quoted.mimeType = descriptor.mimeType;
      }
    };

    const downloadDescriptor = async (descriptor: MediaAttachmentDescriptor, throwOnFailure: boolean): Promise<MediaAttachmentDescriptor | null> => {
      if (descriptor.state === 'ready' && descriptor.mediaPath) return descriptor;
      if (descriptor.state === 'skipped') {
        if (skipMediaDownload) {
          descriptor.state = 'pending';
          descriptor.error = undefined;
        } else {
          if (throwOnFailure) throw new ProviderOperationError('whatsapp', 'downloadMedia', descriptor.error || 'Media is unavailable.');
          return null;
        }
      }
      const source = sourceById.get(descriptor.id);
      if (!source) return null;
      const controller = new AbortController();
      this.mediaControllers.add(controller);
      let savedPath: string | undefined;
      try {
        const stream = await downloadMediaMessage(
          source.message,
          'stream',
          { options: { signal: controller.signal } },
          createMediaDownloadOptions(socket),
        );
        const saved = await saveMediaStream(stream, {
          maxBytes: HARD_MEDIA_MAX_BYTES,
          contentLength: source.info.sizeBytes ?? null,
          fallbackMime: source.info.mimeType,
          signal: controller.signal,
        });
        savedPath = saved.path;
        this.ensureSocket(socket, generation, 'downloadMedia');
        descriptor.mediaPath = saved.path;
        descriptor.mimeType = saved.mime;
        descriptor.state = 'ready';
        descriptor.error = undefined;
        if (selectedAttachmentId === descriptor.id) updateSelected(descriptor);
        return descriptor;
      } catch (error) {
        if (savedPath) await deleteSavedMedia(savedPath).catch(() => false);
        descriptor.state = 'error';
        descriptor.error = errorMessage(error).slice(0, 500);
        logger.warn({ err: error, attachmentId: descriptor.id }, '[WhatsApp] Failed to download media');
        if (throwOnFailure) throw new ProviderOperationError('whatsapp', 'downloadMedia', descriptor.error, error);
        return null;
      } finally {
        this.mediaControllers.delete(controller);
      }
    };

    const mediaReady = createLazyPromise(async () => {
      if (skipMediaDownload) return;
      if (defaultSource) await downloadDescriptor(defaultSource.descriptor, false);
    });

    const selectMediaAttachment = async (attachmentId: string): Promise<MediaAttachmentDescriptor> => {
      const descriptor = descriptors.find(candidate => candidate.id === attachmentId);
      if (!descriptor) throw new ProviderOperationError('whatsapp', 'selectMediaAttachment', `Unknown WhatsApp attachment: ${attachmentId}.`, undefined, 'INVALID_TARGET');
      const downloaded = await downloadDescriptor(descriptor, true);
      if (!downloaded) throw new ProviderOperationError('whatsapp', 'selectMediaAttachment', 'WhatsApp attachment could not be downloaded.');
      updateSelected(downloaded);
      return { ...downloaded };
    };

    const downloadMedia = async (attachmentId?: string): Promise<Buffer | null> => {
      const id = attachmentId ?? selectedAttachmentId;
      if (!id) return null;
      const descriptor = await selectMediaAttachment(id);
      // Match the cap this provider downloads with. The previous call used
      // readMediaBuffer's 32 MiB default while the download allowed 200 MiB, so
      // any attachment between the two was stored, reported 'ready', billed
      // against the media budget, and then always threw on read.
      return descriptor.mediaPath ? readMediaBuffer(descriptor.mediaPath, HARD_MEDIA_MAX_BYTES) : null;
    };

    const senderIdForRoles = senderId;
    let rolesCache: string[] | null = null;
    const identityLid = senderId.includes('@lid') ? senderId : undefined;
    const identityPn = senderPn && !senderPn.includes('@lid') ? senderPn : undefined;
    if (identityLid || identityPn) {
      IdentityService.upsertIdentity(identityLid ?? null, identityPn ?? null, message.pushName ?? undefined, 'whatsapp').catch((error: unknown) => {
        logger.warn({ err: error }, '[WhatsApp] Identity upsert failed');
      });
    }
    const botPn = socket.user?.id ? WhatsAppProvider.botPnJid(socket.user.id) : '';
    const isBotMentioned = parsed.mentionedIds.some(mentioned => {
      if (this.botLid && mentioned === this.botLid) return true;
      return !!botPn && mentioned.split('@')[0] === botPn.split('@')[0];
    });

    return {
      platform: 'whatsapp',
      receivedAt: Date.now(),
      messageId: message.key.id || 'unknown',
      chatId: jid,
      senderId,
      senderPn,
      senderName: message.pushName || 'Unknown',
      text: parsed.text,
      messageType: parsed.messageType,
      isGroup,
      mentionedIds: parsed.mentionedIds,
      isBotMentioned,
      hasMedia: parsed.hasMedia,
      get mediaPath() { return mediaPath; },
      get mimeType() { return mimeType; },
      mediaReady,
      mediaAttachments: descriptors,
      get selectedAttachmentId() { return selectedAttachmentId; },
      selectMediaAttachment,
      getMediaAttachment: id => descriptors.find(descriptor => descriptor.id === id),
      quoted,
      rawMessage: message as unknown as RawProviderMessage,

      downloadMedia,

      sendMedia: async (buffer: Buffer, options: SendMediaOptions = {}) => {
        assertSocket();
        const mime = options.mimetype || 'application/octet-stream';
        if (options.ptt || mime.startsWith('audio/')) {
          await socket.sendMessage(jid, { audio: buffer, mimetype: mime, ptt: !!options.ptt }, { quoted: message });
        } else if (mime.startsWith('video/')) {
          await socket.sendMessage(jid, { video: buffer, caption: options.caption || '', mimetype: mime }, { quoted: message });
        } else if (mime.startsWith('image/')) {
          await socket.sendMessage(jid, { image: buffer, caption: options.caption || '', mimetype: mime }, { quoted: message });
        } else {
          await socket.sendMessage(jid, {
            document: buffer,
            mimetype: mime,
            fileName: options.filename || 'file',
            caption: options.caption,
          }, { quoted: message });
        }
      },

      reply: async (replyText: string, options?: ReplyOptions) => {
        assertSocket();
        const chunks = chunkWhatsAppText(replyText);
        for (let index = 0; index < chunks.length; index++) {
          options?.signal?.throwIfAborted();
          await socket.sendMessage(jid, { text: chunks[index], mentions: index === 0 ? options?.mentions : undefined }, { quoted: message });
        }
      },

      sendTyping: async () => {
        if (!this.isCurrent(socket, generation)) return;
        await socket.sendPresenceUpdate('composing', jid).catch(() => undefined);
      },

      sendMessage: async (text: string, options?: ReplyOptions) => {
        assertSocket();
        const chunks = chunkWhatsAppText(text);
        let sent: WAMessage | undefined;
        for (let index = 0; index < chunks.length; index++) {
          sent = await socket.sendMessage(jid, { text: chunks[index], mentions: index === 0 ? options?.mentions : undefined }, { quoted: message });
        }
        return sent?.key;
      },

      sendToChat: async (targetChatId: string, text: string, options?: ReplyOptions) => {
        assertSocket();
        const chunks = chunkWhatsAppText(text);
        let sent: WAMessage | undefined;
        for (const chunk of chunks) {
          options?.signal?.throwIfAborted();
          sent = await socket.sendMessage(targetChatId, { text: chunk });
        }
        return sent?.key;
      },

      editMessage: async (key: unknown, text: string) => {
        assertSocket();
        const chunks = chunkWhatsAppText(text);
        await socket.sendMessage(jid, { text: chunks[0], edit: key as proto.IMessageKey });
        for (const chunk of chunks.slice(1)) await socket.sendMessage(jid, { text: chunk });
      },

      react: async (emoji: string) => {
        assertSocket();
        await socket.sendMessage(jid, { react: { text: emoji, key: message.key } });
      },

      sendSticker: async (buffer: Buffer) => {
        assertSocket();
        await socket.sendMessage(jid, { sticker: buffer }, { quoted: message });
      },

      deleteMessage: async (key?: unknown) => {
        assertSocket();
        const target = isProviderMessageKey(key) ? key : message.key;
        await socket.sendMessage(target.remoteJid || jid, { delete: target });
      },

      forwardMessage: async (targetJid: string, text?: string) => {
        assertSocket();
        if (text !== undefined) {
          for (const chunk of chunkWhatsAppText(text)) await socket.sendMessage(targetJid, { text: chunk });
        } else {
          await socket.sendMessage(targetJid, { forward: message });
        }
      },

      updateGroupParticipants: async (action, userIds) => {
        assertSocket();
        if (!isGroup) throw new ProviderOperationError('whatsapp', 'updateGroupParticipants', 'Not inside a group.');
        await socket.groupParticipantsUpdate(jid, userIds, action);
      },

      getGroupInviteLink: async (chatId: string) => {
        assertSocket();
        return `https://chat.whatsapp.com/${await socket.groupInviteCode(chatId)}`;
      },

      setGroupSettings: async (chatId: string, setting: 'announcement' | 'not_announcement') => {
        assertSocket();
        await socket.groupSettingUpdate(chatId, setting);
      },

      leaveGroup: async () => {
        assertSocket();
        if (!isGroup) throw new ProviderOperationError('whatsapp', 'leaveGroup', 'Not inside a group.');
        await socket.groupLeave(jid);
      },

      checkPermissions: async (required: string) => {
        assertSocket();
        return checkPermissions(socket, jid, senderIdForRoles, isGroup, required, senderPn);
      },

      resolveRoles: async () => {
        assertSocket();
        if (!rolesCache) rolesCache = await resolveUserRoles(socket, jid, senderIdForRoles, isGroup, senderPn);
        return rolesCache;
      },
    };
  }

  private requireRunningSocket(operation: string): BaileysSocket {
    if (!this.sock || this.providerStatus !== 'running') throw new ProviderLifecycleError('whatsapp', operation);
    return this.sock;
  }

  private ensureGeneration(generation: number): void {
    if (!this.desiredRunning || generation !== this.generation) throw new ProviderLifecycleError('whatsapp', 'start');
  }

  private ensureSocket(socket: BaileysSocket, generation: number, operation: string): void {
    if (!this.desiredRunning || generation !== this.generation || this.sock !== socket) {
      throw new ProviderLifecycleError('whatsapp', operation);
    }
  }

  private isCurrent(socket: BaileysSocket, generation: number): boolean {
    return this.desiredRunning && generation === this.generation && this.sock === socket;
  }
}

function getLidMapping(socket: BaileysSocket): LidMapping | undefined {
  return (socket as unknown as SocketWithSignalRepository).signalRepository?.lidMapping;
}

async function resolveLidForPn(socket: BaileysSocket, targetJid: string): Promise<string | null> {
  return getLidMapping(socket)?.getLIDForPN(targetJid) ?? null;
}

function createMediaDownloadOptions(socket: BaileysSocket): MediaDownloadOptions {
  return {
    logger: logger as unknown as MediaDownloadOptions['logger'],
    reuploadRequest: socket.updateMediaMessage,
  };
}

function isProviderMessageKey(value: unknown): value is ProviderMessageKey {
  if (typeof value !== 'object' || value === null || !('remoteJid' in value)) return false;
  const remoteJid = (value as { remoteJid?: unknown }).remoteJid;
  return typeof remoteJid === 'string' || remoteJid === null || remoteJid === undefined;
}

function extractStoredMessage(rawMessage: string | null): proto.IMessage | undefined {
  if (!rawMessage) return undefined;
  try {
    const parsed = JSON.parse(rawMessage) as Record<string, unknown>;
    if (parsed.message && typeof parsed.message === 'object' && !Array.isArray(parsed.message)) {
      return parsed.message as proto.IMessage;
    }
    const messageKeys = [
      'conversation', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage',
      'extendedTextMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage',
    ];
    return messageKeys.some(key => key in parsed) ? parsed as proto.IMessage : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return Array.from(error instanceof Error ? error.message : String(error), character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  }).join('').slice(0, 500);
}
