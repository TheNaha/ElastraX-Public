import makeWASocket, {
  DisconnectReason,
  WAMessage,
  proto,
  downloadMediaMessage,
  getDevice
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { BotProvider } from './BotProvider';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';
import { checkPermissions } from '../utils/permissions';
import { useDBAuthState } from '../utils/useDBAuthState';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { fileTypeFromBuffer } from 'file-type';
import { syncHistoricalDatabase } from '../utils/syncHistoricalDatabase';

export class WhatsAppProvider implements BotProvider {
  name = 'whatsapp' as const;
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private messageHandler: ((ctx: MessageContext) => Promise<void>) | null = null;

  async start(): Promise<void> {
    const { state, saveCreds } = await useDBAuthState();

    // We can pass our custom logger, but Baileys is very noisy on info/debug.
    // It's usually best to keep Baileys internal logger silent/warn unless debugging connection issues.
    const baileysLogger = logger.child({ module: 'baileys' });
    baileysLogger.level = 'warn';

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: baileysLogger as any,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
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

    this.sock.ev.on('messaging-history.set', async ({ messages }) => {
      logger.info(`[WhatsApp] Received history sync with ${messages.length} messages.`);
      
      const contexts: MessageContext[] = [];
      for (const msg of messages) {
        if (!msg.message) continue;
        
        // Disable auto-download during bulk history sync via an internal flag if necessary, 
        // or just let createContext run. createContext only auto-downloads if we tell it to.
        // Wait, createContext automatically downloads media if hasMedia is true. 
        // We probably don't want to download thousands of historical images right now.
        // Let's pass a flag to createContext to skip bulk downloads.
        try {
          const ctx = await this.createContext(msg, true); // true = skipMediaDownload
          if (ctx) {
            contexts.push(ctx);
          }
        } catch (e) {
          logger.warn({ id: msg.key.id }, 'Failed to parse historical message context');
        }
      }

      // Send them to the background sync engine
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
    if (!this.sock) return null;
    const jid = msg.key.remoteJid;
    if (!jid) return null;

    const isGroup = jid.endsWith('@g.us');
    const senderId = isGroup ? msg.key.participant : jid;
    
    // Extract text from standard, extended, or media caption messages
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      '';
      
    const contextInfo =
      msg.message?.extendedTextMessage?.contextInfo || 
      msg.message?.imageMessage?.contextInfo || 
      msg.message?.videoMessage?.contextInfo ||
      msg.message?.stickerMessage?.contextInfo;

    const mentionedIds = contextInfo?.mentionedJid || [];

    const sock = this.sock;
    if (!sock) return null;

    const hasMediaMessage = (msgObj: proto.IMessage | null | undefined): boolean => {
      if (!msgObj) return false;
      return !!(
        msgObj.imageMessage ||
        msgObj.videoMessage ||
        msgObj.audioMessage ||
        msgObj.documentMessage ||
        msgObj.stickerMessage ||
        msgObj.viewOnceMessageV2?.message?.imageMessage ||
        msgObj.viewOnceMessageV2?.message?.videoMessage
      );
    };

    const hasMedia = hasMediaMessage(msg.message);
    
    const quotedMessage = contextInfo?.quotedMessage;
    const quotedParticipant = contextInfo?.participant;

    let quoted: MessageContext['quoted'] = undefined;

    if (quotedMessage && quotedParticipant) {
      const quotedText = 
        quotedMessage.conversation ||
        quotedMessage.extendedTextMessage?.text ||
        quotedMessage.imageMessage?.caption ||
        quotedMessage.videoMessage?.caption ||
        '';

      // Reconstruct a WAMessage-like structure for the quoted message
      const normalizeJid = (jid?: string | null) => jid ? jid.split('@')[0].split(':')[0] : '';
      const reconstructedQuotedWAMessage: WAMessage = {
         key: {
            remoteJid: jid,
            fromMe: normalizeJid(sock.user?.id) === normalizeJid(quotedParticipant),
            id: contextInfo?.stanzaId,
            participant: quotedParticipant
         },
         message: quotedMessage
      };

      quoted = {
        rawMessage: reconstructedQuotedWAMessage,
        senderId: quotedParticipant,
        text: quotedText,
        hasMedia: hasMediaMessage(quotedMessage),
      };
    }

    // Media downloads run in the background immediately after context creation.
    // The main message handler is NOT blocked — it proceeds straight to AI/tool processing.
    // Tools that need media (e.g. MakeStickerTool) call `await ctx.mediaReady` to wait
    // only as long as needed, then read ctx.mediaPath / ctx.mimeType.
    let mediaPath: string | undefined;
    let mimeType: string | undefined;

    // helper to save buffer to disk
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

    // Build a single Promise that downloads both the main message media AND
    // the quoted media concurrently. Resolves immediately if nothing to download.
    const mediaReadyPromise: Promise<void> = (async () => {
      if (skipMediaDownload) return;
      const tasks: Promise<void>[] = [];

      if (hasMedia) {
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

      if (quoted?.hasMedia) {
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

      await Promise.allSettled(tasks);
    })();

    const downloadMedia = async (): Promise<Buffer | null> => {
      // Legacy compatibility: some tools might still call this, or it can fall back to the newly saved paths if we want.
      // Easiest is to keep functionality identical as before for tools that don't transition to mediaPath immediately.
      try {
        if (hasMedia) {
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

    return {
      platform: 'whatsapp',
      messageId: msg.key.id || 'unknown',
      chatId: jid,
      senderId: senderId || jid,
      senderName: msg.pushName || 'Unknown',
      text,
      isGroup,
      mentionedIds,
      hasMedia,
      mediaPath,
      mimeType,
      mediaReady: mediaReadyPromise,
      quoted,
      rawMessage: msg,
      downloadMedia,
      reply: async (replyText: string) => {
        await sock.sendMessage(jid, { text: replyText }, { quoted: msg });
      },
      react: async (emoji: string) => {
        await sock.sendMessage(jid, {
          react: { text: emoji, key: msg.key }
        });
      },
      sendSticker: async (buffer: Buffer) => {
        await sock.sendMessage(jid, { sticker: buffer }, { quoted: msg });
      },
      updateGroupParticipants: async (action: 'add' | 'remove', userIds: string[]) => {
        if (!isGroup) throw new Error("Not inside a group.");
        await sock.groupParticipantsUpdate(jid, userIds, action);
      },
      checkPermissions: async (required: 'user' | 'admin' | 'owner') => {
        return checkPermissions(sock, jid, senderId || jid, isGroup, required);
      },
    };
  }
}
