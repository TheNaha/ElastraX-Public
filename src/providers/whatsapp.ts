import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WAMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { BotProvider } from './BotProvider';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';

export class WhatsAppProvider implements BotProvider {
  name: 'whatsapp' = 'whatsapp';
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
    
    // Extract text from standard or extended text message
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      '';
      
    const mentionedIds =
      msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

    const sock = this.sock;

    return {
      platform: 'whatsapp',
      chatId: jid,
      senderId: senderId || jid,
      senderName: msg.pushName || 'Unknown',
      text,
      isGroup,
      mentionedIds,
      rawMessage: msg,
      reply: async (replyText: string) => {
        await sock.sendMessage(jid, { text: replyText }, { quoted: msg });
      },
      react: async (emoji: string) => {
        await sock.sendMessage(jid, {
          react: { text: emoji, key: msg.key }
        });
      },
    };
  }
}
