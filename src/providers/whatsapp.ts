import makeWASocket, {
  DisconnectReason,
  WAMessage,
  proto,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { BotProvider } from './BotProvider';
import { MessageContext, SendMediaOptions } from '../core/MessageContext';
import { logger } from '../utils/logger';
import { checkPermissions } from '../utils/permissions';
import { useDBAuthState } from '../utils/useDBAuthState';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { fileTypeFromBuffer } from 'file-type';
import { syncHistoricalDatabase } from '../utils/syncHistoricalDatabase';
import { parseWhatsAppMessage, getFileLength } from './whatsappParser';
import { db } from '../db';
import { messages } from '../db/schema';
import { eq } from 'drizzle-orm';

const MAX_MEDIA_SIZE = 50 * 1024 * 1024; // 50MB

export class WhatsAppProvider implements BotProvider {
  name = 'whatsapp' as const;
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private messageHandler: ((ctx: MessageContext) => Promise<void>) | null = null;
  /**
   * The bot's own LID JID (e.g. "265841933336713@lid"), resolved once the
   * connection is open via sock.signalRepository.lidMapping.getLIDForPN().
   * Used to correctly detect `fromMe` in V7 LID-based sessions where
   * contextInfo.participant is a LID rather than a phone-number JID.
   */
  private botLid: string | null = null;

  /** Convert sock.user.id (e.g. "628xxx:0@s.whatsapp.net") to a bare PN JID. */
  private static botPnJid(userId: string): string {
    return userId.split(':')[0].split('@')[0] + '@s.whatsapp.net';
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useDBAuthState();

    const baileysLogger = logger.child({ module: 'baileys' });
    baileysLogger.level = 'warn';

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: baileysLogger as any,
      // Allows Baileys to decrypt messages whose Signal session key is not in memory
      // by looking them up in the SQLite message store. Fixes "No session to decrypt" errors.
      getMessage: async (key) => {
        try {
          const row = await db.select()
            .from(messages)
            .where(eq(messages.providerMessageId, key.id ?? ''))
            .limit(1);
          if (row[0]?.rawMessage) {
            return JSON.parse(row[0].rawMessage) as proto.IMessage;
          }
        } catch { /* ignore db errors */ }
        return proto.Message.fromObject({});
      },
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        logger.info('[WhatsApp] Scan this QR code to login:');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'close') {
        const shouldReconnect =
          (lastDisconnect?.error as Boom)?.output?.statusCode !==
          DisconnectReason.loggedOut;

        logger.warn(
          { err: lastDisconnect?.error, shouldReconnect },
          '[WhatsApp] Connection closed'
        );

        if (shouldReconnect) {
          this.start();
        }
      } else if (connection === 'open') {
        logger.info('[WhatsApp] Connected successfully!');
        // Resolve the bot's LID via Baileys' LID-PN mapping store.
        // In WA V7 sessions, contextInfo.participant uses LIDs so we need
        // the bot's own LID to correctly set `fromMe` on quoted messages.
        if (this.sock?.user?.id) {
          const botPn = WhatsAppProvider.botPnJid(this.sock.user.id);
          try {
            this.botLid = await (this.sock as any).signalRepository.lidMapping.getLIDForPN(botPn);
            if (this.botLid) {
              logger.info({ botLid: this.botLid }, '[WhatsApp] Resolved bot LID');
            }
          } catch (err) {
            logger.debug({ err }, '[WhatsApp] Could not resolve bot LID (will retry per-message)');
          }
        }
      }
    });

    this.sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;
      if (m.type !== 'notify') return;

      if (this.messageHandler) {
        const ctx = await this.createContext(msg);
        if (ctx) {
          await this.messageHandler(ctx);
        }
      }
    });

    this.sock.ev.on('messaging-history.set', async ({ messages: histMsgs }) => {
      logger.info(`[WhatsApp] Received history sync with ${histMsgs.length} messages.`);

      const contexts: MessageContext[] = [];
      for (const msg of histMsgs) {
        if (!msg.message) continue;
        try {
          const ctx = await this.createContext(msg, true); // true = skipMediaDownload
          if (ctx) contexts.push(ctx);
        } catch (e) {
          logger.warn({ id: msg.key.id }, 'Failed to parse historical message context');
        }
      }

      syncHistoricalDatabase(contexts).catch(err => {
        logger.error(err, 'Background history sync failed');
      });
    });
  }

  async stop(): Promise<void> {
    this.sock?.end(new Error('Stop called'));
  }

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  private async createContext(msg: WAMessage, skipMediaDownload: boolean = false): Promise<MessageContext | null> {
    const sock = this.sock;
    if (!sock) return null;
    const jid = msg.key.remoteJid;
    if (!jid) return null;

    // ── Parse the raw message (pure, testable) ──────────────────────────────
    // If botLid hasn't been resolved yet (e.g. very first message before
    // the mapping was available), attempt a lazy lookup now.
    if (!this.botLid && sock.user?.id) {
      const botPn = WhatsAppProvider.botPnJid(sock.user.id);
      try {
        this.botLid = await (sock as any).signalRepository.lidMapping.getLIDForPN(botPn);
      } catch { /* best-effort; PN comparison still works for non-LID sessions */ }
    }

    const resolveLid = async (targetJid: string): Promise<string> => {
      if (!targetJid) return targetJid;
      if (targetJid.includes('@lid') || targetJid.includes('@g.us') || targetJid.includes('@broadcast')) {
        return targetJid;
      }
      try {
        const lid = await (sock as any).signalRepository.lidMapping.getLIDForPN(targetJid);
        if (lid) return lid;
      } catch { /* ignore */ }
      return targetJid; // fallback to PN
    };

    const parsed = await parseWhatsAppMessage(msg, sock.user?.id, this.botLid, resolveLid);

    const isGroup = jid.endsWith('@g.us');

    // ── V7 LID-first sender resolution ──────────────────────────────────────
    // Groups: key.participant   = @lid JID (preferred), key.participantPn = PN fallback
    // DMs:    key.senderLid     = @lid JID (preferred), key.remoteJid     = PN fallback
    const keyAny = msg.key as any;
    const rawSender: string = isGroup
      ? (msg.key.participant ?? msg.key.remoteJid ?? jid)
      : (keyAny.senderLid ?? jid);

    // Mandate LID for sender
    const senderId: string = await resolveLid(rawSender);

    // Best-effort phone number — may be absent for LID-only sessions
    const _senderPn: string | undefined = isGroup
      ? (keyAny.participantPn ?? undefined)
      : (!senderId.includes('@lid') ? senderId : (keyAny.remoteJidAlt ?? undefined));

    // ── Build quoted context object (adds socket-dependent WAMessage key) ───
    let quoted: MessageContext['quoted'] = undefined;
    if (parsed.quoted) {
      const q = parsed.quoted;
      const reconstructedKey = {
        remoteJid: jid,
        fromMe: q.fromMe,
        id: q.stanzaId,
        participant: q.senderId,
      };
      quoted = {
        messageType: q.messageType,
        body: q.body,
        text: q.body,       // backwards compat alias
        senderId: q.senderId,
        hasMedia: q.hasMedia,
        stanzaId: q.stanzaId ?? undefined,
        rawMessage: {
          key: reconstructedKey,
          message: q.rawMessage,
        },
      };
    }

    // ── Media saving helper ──────────────────────────────────────────────────
    const saveBuffer = async (buffer: Buffer): Promise<{ path: string; mime: string } | null> => {
      try {
        const typeInfo = await fileTypeFromBuffer(buffer);
        const mime = typeInfo?.mime ?? 'application/octet-stream';
        const ext = typeInfo?.ext ?? 'bin';
        const filename = `${randomUUID()}.${ext}`;
        const filepath = join('./data/media', filename);
        await writeFile(filepath, buffer);
        return { path: filepath, mime };
      } catch (err) {
        logger.error(err, 'Failed to save buffer to disk');
        return null;
      }
    };

    // ── Background media download ────────────────────────────────────────────
    // Kicked off immediately — does NOT block context creation.
    // Callers use `await ctx.mediaReady` then read ctx.mediaPath / ctx.mimeType.
    let mediaPath: string | undefined;
    let mimeType: string | undefined;

    const mediaReadyPromise: Promise<void> = (async () => {
      if (skipMediaDownload) return;
      const tasks: Promise<void>[] = [];

      if (parsed.hasMedia) {
        const size = getFileLength(msg.message);
        if (size && size > MAX_MEDIA_SIZE) {
          logger.warn({ size, max: MAX_MEDIA_SIZE }, '[WhatsApp] Skipped large media download');
        } else {
          tasks.push(
            downloadMediaMessage(msg, 'buffer', {}, { logger: logger as any, reuploadRequest: sock.updateMediaMessage })
              .then(async (buf) => {
                const buffer = buf as Buffer | null;
                if (buffer) {
                  const saved = await saveBuffer(buffer);
                  if (saved) { mediaPath = saved.path; mimeType = saved.mime; }
                }
              })
              .catch((err) => logger.warn({ err }, '[WhatsApp] Failed to download message media'))
          );
        }
      }

      if (quoted?.hasMedia) {
        const size = getFileLength(quoted.rawMessage);
        if (size && size > MAX_MEDIA_SIZE) {
          logger.warn({ size, max: MAX_MEDIA_SIZE }, '[WhatsApp] Skipped large quoted media download');
        } else {
          tasks.push(
            downloadMediaMessage(quoted.rawMessage, 'buffer', {}, { logger: logger as any, reuploadRequest: sock.updateMediaMessage })
              .then(async (buf) => {
                const buffer = buf as Buffer | null;
                if (buffer) {
                  const saved = await saveBuffer(buffer);
                  if (saved && quoted) { quoted.mediaPath = saved.path; quoted.mimeType = saved.mime; }
                }
              })
              .catch((err) => logger.warn({ err }, '[WhatsApp] Failed to download quoted media'))
          );
        }
      }

      await Promise.allSettled(tasks);
    })();

    // ── Legacy downloadMedia() shim ─────────────────────────────────────────
    const downloadMedia = async (): Promise<Buffer | null> => {
      try {
        if (parsed.hasMedia) {
          return (await downloadMediaMessage(msg, 'buffer', {}, { logger: logger as any, reuploadRequest: sock.updateMediaMessage })) as Buffer;
        } else if (quoted?.hasMedia) {
          return (await downloadMediaMessage(quoted.rawMessage, 'buffer', {}, { logger: logger as any, reuploadRequest: sock.updateMediaMessage })) as Buffer;
        }
        return null;
      } catch (err) {
        logger.error(err, 'Failed to download WhatsApp media');
        return null;
      }
    };

    // ── sendMedia helper ────────────────────────────────────────────────────
    const sendMedia = async (buffer: Buffer, options: SendMediaOptions = {}): Promise<void> => {
      const { caption, mimetype, filename, ptt } = options;
      const mime = mimetype ?? 'application/octet-stream';

      if (ptt || mime.startsWith('audio')) {
        await sock.sendMessage(jid, { audio: buffer, mimetype: mime, ptt: !!ptt }, { quoted: msg });
      } else if (mime.startsWith('video')) {
        await sock.sendMessage(jid, { video: buffer, caption: caption ?? '', mimetype: mime }, { quoted: msg });
      } else if (mime.startsWith('image')) {
        await sock.sendMessage(jid, { image: buffer, caption: caption ?? '', mimetype: mime }, { quoted: msg });
      } else {
        await sock.sendMessage(jid, {
          document: buffer,
          mimetype: mime,
          fileName: filename ?? 'file',
          caption: caption,
        }, { quoted: msg });
      }
    };

    // ── Assemble the full MessageContext ────────────────────────────────────
    return {
      platform: 'whatsapp',
      messageId: msg.key.id ?? 'unknown',
      chatId: jid,
      senderId,
      senderName: msg.pushName ?? 'Unknown',
      text: parsed.text,
      messageType: parsed.messageType,
      isGroup,
      mentionedIds: parsed.mentionedIds,
      hasMedia: parsed.hasMedia,
      mediaPath,
      mimeType,
      mediaReady: mediaReadyPromise,
      quoted,
      rawMessage: msg,

      // ── Methods ──────────────────────────────────────────────────────────
      downloadMedia,
      sendMedia,

      reply: async (replyText: string) => {
        await sock.sendMessage(jid, { text: replyText }, { quoted: msg });
      },

      react: async (emoji: string) => {
        await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
      },

      sendSticker: async (buffer: Buffer) => {
        await sock.sendMessage(jid, { sticker: buffer }, { quoted: msg });
      },

      deleteMessage: async (key?: any) => {
        const target = key ?? msg.key;
        await sock.sendMessage(target.remoteJid ?? jid, { delete: target });
      },

      forwardMessage: async (targetJid: string) => {
        await sock.sendMessage(targetJid, { forward: msg });
      },

      updateGroupParticipants: async (action: 'add' | 'remove', userIds: string[]) => {
        if (!isGroup) throw new Error('Not inside a group.');
        await sock.groupParticipantsUpdate(jid, userIds, action);
      },

      checkPermissions: async (required: 'user' | 'admin' | 'owner') => {
        return checkPermissions(sock, jid, senderId, isGroup, required);
      },
    };
  }
}
