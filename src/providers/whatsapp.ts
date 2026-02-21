import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WAMessage,
  proto,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { BotProvider } from './BotProvider';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';
import { checkPermissions } from '../utils/permissions';

export class WhatsAppProvider implements BotProvider {
  name = 'whatsapp' as const;
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private messageHandler: ((ctx: MessageContext) => Promise<void>) | null = null;
  private authDir = './data/auth_info_baileys';

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

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
        const ctx = this.createContext(msg);
        if (ctx) {
          await this.messageHandler(ctx);
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.sock?.end(new Error('Stop called'));
  }

  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  private createContext(msg: WAMessage): MessageContext | null {
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
      const reconstructedQuotedWAMessage: WAMessage = {
         key: {
            remoteJid: jid,
            fromMe: quotedParticipant === sock.user?.id,
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

    const downloadMedia = async (): Promise<Buffer | null> => {
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
      chatId: jid,
      senderId: senderId || jid,
      senderName: msg.pushName || 'Unknown',
      text,
      isGroup,
      mentionedIds,
      hasMedia,
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
