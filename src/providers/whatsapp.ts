/**
 * @file src/providers/whatsapp.ts
 * @description WhatsApp messaging provider for ElastraX, built on top of the
 *              Baileys library (@whiskeysockets/baileys).
 *
 * Responsibilities:
 *  - Manage the WhatsApp WebSocket connection lifecycle (connect, auto-reconnect, disconnect).
 *  - Display a QR code in the terminal on first run so the user can link their phone.
 *  - Persist Baileys authentication credentials to the SQLite `wa_auth_state` table via
 *    `useDBAuthState` — no file-system sessions folder required.
 *  - Sync historical messages sent before the bot started into the database.
 *  - For each incoming `notify` message, parse the raw Baileys WAMessage into a
 *    normalised `MessageContext` and forward it to the registered message handler.
 *  - Handle WhatsApp V7 LID (Linked ID) sessions where participant JIDs are in
 *    "@lid" format rather than the classic phone-number "@s.whatsapp.net" format.
 *  - Download and cache attached media to `./data/media/` asynchronously so
 *    tools can access the file without hitting the CDN again.
 *
 * Key concepts:
 *  - `botLid` — The bot's own LID JID, resolved once after connection.  Used to
 *    correctly mark quoted messages as "from the bot" in LID sessions.
 *  - `mediaReady` — A Promise exposed on every `MessageContext` that resolves once
 *    background media download is complete; tools `await ctx.mediaReady` before reading
 *    `ctx.mediaPath`.
 */

import makeWASocket, {
  DisconnectReason,
  WAMessage,
  proto,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { BotProvider } from './BotProvider';
import { MessageContext, SendMediaOptions } from '../core/MessageContext';
import { logger } from '../utils/logger';
import { checkPermissions, resolveUserRoles } from '../utils/permissions';
import { useDBAuthState } from '../utils/useDBAuthState';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { fileTypeFromBuffer } from 'file-type';
import { saveMediaBuffer } from '../utils/MediaStorage';
import { syncHistoricalDatabase } from '../utils/syncHistoricalDatabase';
import { parseWhatsAppMessage, getFileLength } from './whatsappParser';
import { db } from '../db';
import { messages } from '../db/schema';
import { eq } from 'drizzle-orm';

/** Maximum file size in bytes that the bot will attempt to download (200 MB). */
const MAX_MEDIA_SIZE = 200 * 1024 * 1024; // 200MB

/**
 * WhatsApp platform provider.  Implements the `BotProvider` interface and manages
 * the full Baileys WebSocket session from QR-code login to graceful shutdown.
 */
export class WhatsAppProvider implements BotProvider {
  name = 'whatsapp' as const;
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private messageHandler: ((ctx: MessageContext) => Promise<void>) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private starting = false;
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

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((err) => {
        logger.error({ err }, '[WhatsApp] Reconnect start failed');
      });
    }, 1500);
  }

  /**
   * Initialises the Baileys WebSocket socket, registers all event handlers,
   * and begins the WhatsApp connection handshake (QR code or cached session).
   */
  async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;

    const { state, saveCreds } = await useDBAuthState();
    const { version, isLatest } = await fetchLatestBaileysVersion();

    const baileysLogger = logger.child({ module: 'baileys' });
    baileysLogger.level = 'warn';

    logger.info(`[WhatsApp] Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const existingSock = this.sock;
    if (existingSock) {
      try {
        existingSock.end(new Error('Restarting WhatsApp socket'));
      } catch {
        // no-op
      }
      this.sock = null;
    }

    const sock = makeWASocket({
      version,
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
    this.sock = sock;
    this.starting = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      if (this.sock !== sock) return;
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

        this.sock = null;

        if (shouldReconnect) {
          this.scheduleReconnect();
        }
      } else if (connection === 'open') {
        logger.info('[WhatsApp] Connected successfully!');
        // Resolve the bot's LID via Baileys' LID-PN mapping store.
        // In WA V7 sessions, contextInfo.participant uses LIDs so we need
        // the bot's own LID to correctly set `fromMe` on quoted messages.
        if (sock.user?.id) {
          const botPn = WhatsAppProvider.botPnJid(sock.user.id);
          try {
            this.botLid = await (sock as any).signalRepository.lidMapping.getLIDForPN(botPn);
            if (this.botLid) {
              logger.info({ botLid: this.botLid }, '[WhatsApp] Resolved bot LID');
            }
          } catch (err) {
            logger.debug({ err }, '[WhatsApp] Could not resolve bot LID (will retry per-message)');
          }
        }
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (this.sock !== sock) return;
      if (m.type !== 'notify') return;

      await Promise.all(m.messages.map(async (msg) => {
        if (!msg.message || msg.key.fromMe) return;

        // Automatically mark the message as read (blue checkmark)
        try {
          await sock.readMessages([msg.key]);
        } catch (err) {
          logger.warn({ err, key: msg.key }, '[WhatsApp] Failed to mark message as read');
        }

        if (this.messageHandler) {
          const ctx = await this.createContext(msg);
          if (ctx) {
            await this.messageHandler(ctx);
          }
        }
      }));
    });

    sock.ev.on('messaging-history.set', async ({ messages: histMsgs }) => {
      if (this.sock !== sock) return;
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

  /** Closes the Baileys WebSocket connection gracefully. */
  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.starting = false;
    const sock = this.sock;
    this.sock = null;
    sock?.end(new Error('Stop called'));
  }

  /** Register the application-level callback that will receive every parsed MessageContext. */
  onMessage(handler: (ctx: MessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.sock) {
      throw new Error('WhatsApp socket is not initialized.');
    }
    await this.sock.sendMessage(chatId, { text });
  }

  /**
   * Converts a raw Baileys `WAMessage` into the normalised `MessageContext` used by
   * the agent and tools.
   *
   * Steps performed:
   *  1. Lazy-resolve the bot's LID JID if not already cached.
   *  2. Parse the raw message with the pure `parseWhatsAppMessage` function.
   *  3. Determine the sender JID (LID-first, then phone-number fallback).
   *  4. Reconstruct any quoted/replied-to message into a `quoted` sub-context.
   *  5. Kick off background media downloads (main message and quoted message).
   *  6. Assemble and return the full `MessageContext` with all action methods bound.
   *
   * @param msg               Raw WAMessage from Baileys.
   * @param skipMediaDownload If true, skip background media download (used for history sync).
   * @returns                 Populated `MessageContext`, or `null` if the message cannot be parsed.
   */
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

    logger.debug(
      { jid, isGroup, rawSender, senderId, _senderPn, keyParticipant: msg.key.participant, keyParticipantPn: keyAny.participantPn, senderLid: keyAny.senderLid },
      '[WhatsApp] Sender resolution — LID/PN mapping',
    );

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
      return saveMediaBuffer(buffer);
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
    let _rolesCache: string[] | null = null;

    // Sender phone-number JID for owner/role matching (LID ≠ PN).
    // In DMs, jid IS the phone-number JID.  In groups, use _senderPn.
    const senderPn: string | undefined = isGroup ? _senderPn : jid;

    logger.debug(
      { senderId, senderPn, isGroup, jid },
      '[WhatsApp] Context senderPn resolved — will use for role/owner matching',
    );

    return {
      platform: 'whatsapp',      
      receivedAt: Date.now(),      
      messageId: msg.key.id ?? 'unknown',
      chatId: jid,
      senderId,
      senderPn,
      senderName: msg.pushName ?? 'Unknown',
      text: parsed.text,
      messageType: parsed.messageType,
      isGroup,
      mentionedIds: parsed.mentionedIds,
      hasMedia: parsed.hasMedia,
      get mediaPath() { return mediaPath; },
      get mimeType() { return mimeType; },
      mediaReady: mediaReadyPromise,
      quoted,
      rawMessage: msg,

      // ── Methods ──────────────────────────────────────────────────────────
      downloadMedia,
      sendMedia,

      reply: async (replyText: string) => {
        await sock.sendMessage(jid, { text: replyText }, { quoted: msg });
      },

      sendTyping: async () => {
        try {
          await sock.sendPresenceUpdate('composing', jid);
        } catch { /* best-effort */ }
      },

      sendMessage: async (text: string) => {
        const sent = await sock.sendMessage(jid, { text }, { quoted: msg });
        return sent?.key;
      },

      editMessage: async (key: any, text: string) => {
        try {
          await sock.sendMessage(jid, { text, edit: key });
        } catch (err) {
          logger.warn({ err }, '[WhatsApp] Failed to edit message');
        }
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


      forwardMessage: async (targetJid: string, text?: string) => {
        if (text) {
          // Send a custom text message to the target, not the original message
          await sock.sendMessage(targetJid, { text });
        } else {
          await sock.sendMessage(targetJid, { forward: msg });
        }
      },

      updateGroupParticipants: async (action: 'add' | 'remove' | 'promote' | 'demote', userIds: string[]) => {
        if (!isGroup) throw new Error('Not inside a group.');
        await sock.groupParticipantsUpdate(jid, userIds, action as any);
      },

      getGroupInviteLink: async (chatId: string) => {
        const code = await sock.groupInviteCode(chatId);
        return `https://chat.whatsapp.com/${code}`;
      },

      setGroupSettings: async (chatId: string, setting: 'announcement' | 'not_announcement') => {
        await sock.groupSettingUpdate(chatId, setting);
      },

      leaveGroup: async () => {
        if (!isGroup) throw new Error('Not inside a group.');
        await sock.groupLeave(jid);
      },

      checkPermissions: async (required: string) => {
        return checkPermissions(sock, jid, senderId, isGroup, required, senderPn);
      },

      resolveRoles: async () => {
        if (!_rolesCache) {
          logger.debug({ senderId, senderPn, chatId: jid, isGroup }, '[WhatsApp] resolveRoles invoked — cache miss');
          _rolesCache = await resolveUserRoles(sock, jid, senderId, isGroup, senderPn);
          logger.info({ senderId, senderPn, roles: _rolesCache }, '[WhatsApp] resolveRoles — cached result');
        }
        return _rolesCache;
      },
    };
  }
}
