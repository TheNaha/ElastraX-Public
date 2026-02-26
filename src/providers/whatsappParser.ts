/**
 * @file src/providers/whatsappParser.ts
 * @description Pure, side-effect-free parser for raw Baileys WAMessage objects.
 *
 * The parser is intentionally decoupled from the socket, database, and any I/O so
 * that it can be unit-tested directly with fixture JSON files stored in
 * `test/fixtures/wa_messages/`.
 *
 * Key exported symbols:
 *  - `ParsedWAMessage`      — Normalised view of a WAMessage (type, text, media flag, etc.)
 *  - `ParsedQuotedMessage`  — Normalised view of the quoted/replied-to message.
 *  - `LidResolver`          — Async function type used to map PN JIDs → LID JIDs.
 *  - `parseWhatsAppMessage` — Main parser entry point; handles all known WA message types.
 *  - `getFileLength`        — Extracts the `fileLength` field from a message for size checks.
 *  - `normalizeJid`         — Strips domain and device suffixes from a JID for comparison.
 *
 * Supported message types (unwrapped automatically):
 *  conversation, extendedTextMessage, imageMessage, videoMessage, audioMessage,
 *  documentMessage, stickerMessage, viewOnceMessage, viewOnceMessageV2,
 *  viewOnceMessageV2Extension, documentWithCaptionMessage, listResponseMessage,
 *  buttonsResponseMessage, productMessage, and unknown fallback.
 */

import { WAMessage, proto, getContentType } from '@whiskeysockets/baileys';

/**
 * The pure parsed result of a WAMessage — no socket, no DB, no side effects.
 * Extracted so that `createContext()` in WhatsAppProvider can be a thin wrapper
 * and this logic can be fully unit-tested with fixture JSON files.
 */
export interface ParsedWAMessage {
  /** Canonical Baileys message type, e.g. 'imageMessage', 'audioMessage', 'conversation' */
  messageType: string;
  /** Text body of the message (caption, conversation, button response, etc.) */
  text: string;
  /** True if the message contains any downloadable media */
  hasMedia: boolean;
  /** JID list of users @mentioned in this message */
  mentionedIds: string[];
  /** Parsed quoted / replied-to message, or undefined */
  quoted: ParsedQuotedMessage | undefined;
}

export type LidResolver = (jid: string) => Promise<string>;

export interface ParsedQuotedMessage {
  /** Canonical Baileys message type of the quoted message */
  messageType: string;
  /** Multi-source text body: text || caption || contentText || selectedDisplayText || title */
  body: string;
  /** JID of the sender of the quoted message */
  senderId: string;
  /** True if the quoted message came from this bot (based on botUserId comparison) */
  fromMe: boolean;
  /** True if the quoted message contains downloadable media */
  hasMedia: boolean;
  /** Stanza ID of the quoted message (used to reconstruct the message key) */
  stanzaId: string | null | undefined;
  /** Raw quoted proto.IMessage — needed to reconstruct the WAMessage for downloading */
  rawMessage: proto.IMessage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract file length from a message object, handling wrappers.
 */
export function getFileLength(msgObj: proto.IMessage | null | undefined): number | null {
  if (!msgObj) return null;
  const type = getContentType(msgObj) ?? '';
  let content = (msgObj as any)[type];

  // Unwrap nested containers
  const innerMsg =
    msgObj.viewOnceMessage?.message ||
    msgObj.viewOnceMessageV2?.message ||
    msgObj.viewOnceMessageV2Extension?.message ||
    msgObj.documentWithCaptionMessage?.message;

  if (innerMsg) {
    const innerType = getContentType(innerMsg);
    if (innerType) {
      content = (innerMsg as any)[innerType];
    }
  }

  if (content && typeof content === 'object' && 'fileLength' in content) {
    const len = (content as any).fileLength;
    return len ? Number(len) : null;
  }
  return null;
}

/** Strip domain suffix and device-session suffix from a JID so we can compare bare phone numbers. */
export const normalizeJid = (jid?: string | null): string =>
  jid ? jid.split('@')[0].split(':')[0] : '';

const MEDIA_TYPES = new Set([
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
]);

function hasMediaContent(msgObj: proto.IMessage | null | undefined): boolean {
  if (!msgObj) return false;
  const type = getContentType(msgObj) ?? '';
  if (MEDIA_TYPES.has(type)) return true;
  
  // Unwrap nested containers to check for media
  const innerMsg = 
    msgObj.viewOnceMessage?.message ||
    msgObj.viewOnceMessageV2?.message ||
    msgObj.viewOnceMessageV2Extension?.message ||
    msgObj.documentWithCaptionMessage?.message;
    
  if (innerMsg) {
    const innerType = getContentType(innerMsg);
    if (innerType && MEDIA_TYPES.has(innerType)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a raw Baileys WAMessage into a structured ParsedWAMessage.
 *
 * Pure function — no socket calls, no DB reads, no side effects.
 * Safe to call from unit tests with fixture JSON.
 *
 * @param msg       The raw WAMessage from Baileys
 * @param botUserId The bot's own phone-number JID (e.g. "628xxx:0@s.whatsapp.net")
 * @param botLid    The bot's own LID JID (e.g. "2658xxx@lid"), resolved via
 *                  `sock.signalRepository.lidMapping.getLIDForPN()`.
 *                  Required so that `fromMe` is correctly set in WhatsApp V7
 *                  LID sessions where `contextInfo.participant` is a LID.
 * @param resolveLid Async function to resolve any PN JIDs to LID JIDs.
 */
export async function parseWhatsAppMessage(
  msg: WAMessage,
  botUserId: string | null | undefined,
  botLid?: string | null,
  resolveLid?: LidResolver
): Promise<ParsedWAMessage> {
  const rawMsg = msg.message;

  // ── 1. Detect canonical message type, unwrap nested containers ──────────────
  const rawType = (rawMsg ? getContentType(rawMsg) : null) ?? 'unknown';
  const isWrapper =
    rawType === 'viewOnceMessage' ||
    rawType === 'viewOnceMessageV2' ||
    rawType === 'viewOnceMessageV2Extension' ||
    rawType === 'documentWithCaptionMessage';

  let messageType = rawType;
  let messageContent: any = rawMsg?.[rawType as keyof proto.IMessage];

  if (isWrapper) {
    const inner = (messageContent as any)?.message;
    const innerType = inner ? getContentType(inner) : null;
    if (innerType) {
      messageType = innerType;
      messageContent = inner?.[innerType as keyof proto.IMessage];
    }
  }

  // ── 2. Extract body text ─────────────────────────────────────────────────
  const text: string =
    rawMsg?.conversation ||
    messageContent?.caption ||
    messageContent?.text ||
    (rawType === 'listResponseMessage' &&
      messageContent?.singleSelectReply?.selectedRowId) ||
    (rawType === 'buttonsResponseMessage' && messageContent?.selectedButtonId) ||
    '';

  // ── 3. Resolve contextInfo from any message type ─────────────────────────
  const contextInfo: proto.IContextInfo | null | undefined =
    rawMsg?.extendedTextMessage?.contextInfo ||
    rawMsg?.imageMessage?.contextInfo ||
    rawMsg?.videoMessage?.contextInfo ||
    rawMsg?.audioMessage?.contextInfo ||
    rawMsg?.documentMessage?.contextInfo ||
    rawMsg?.stickerMessage?.contextInfo ||
    messageContent?.contextInfo ||
    null;

  let mentionedIds: string[] = contextInfo?.mentionedJid ?? [];
  if (resolveLid) {
    mentionedIds = await Promise.all(mentionedIds.map(resolveLid));
  }

  // ── 4. Parse quoted message ───────────────────────────────────────────────
  let quoted: ParsedQuotedMessage | undefined;

  const quotedMessage = contextInfo?.quotedMessage;
  let quotedParticipant = contextInfo?.participant;

  if (resolveLid && quotedParticipant) {
    quotedParticipant = await resolveLid(quotedParticipant);
  }

  if (quotedMessage && quotedParticipant) {
    // Detect quoted message type, unwrap productMessage nesting
    let qType = getContentType(quotedMessage) ?? 'unknown';
    let qContent: any = quotedMessage[qType as keyof proto.IMessage];

    const isQWrapper =
      qType === 'viewOnceMessage' ||
      qType === 'viewOnceMessageV2' ||
      qType === 'viewOnceMessageV2Extension' ||
      qType === 'documentWithCaptionMessage';

    if (isQWrapper) {
      const inner = (qContent as any)?.message;
      const innerType = inner ? getContentType(inner) : null;
      if (innerType) {
        qType = innerType;
        qContent = inner?.[innerType as keyof proto.IMessage];
      }
    } else if (qType === 'productMessage') {
      const inner = getContentType(qContent);
      if (inner) { qType = inner; qContent = qContent[inner]; }
    }
    if (typeof qContent === 'string') qContent = { text: qContent };

    // Multi-source body fallback (mirrors v6 adapter)
    const body: string =
      qContent?.text ||
      qContent?.caption ||
      qContent?.conversation ||
      qContent?.contentText ||
      qContent?.selectedDisplayText ||
      qContent?.title ||
      '';

    quoted = {
      messageType: qType,
      body,
      senderId: quotedParticipant,
      fromMe: (normalizeJid(botUserId) !== '' &&
        normalizeJid(botUserId) === normalizeJid(quotedParticipant)) ||
        (normalizeJid(botLid) !== '' &&
        normalizeJid(botLid) === normalizeJid(quotedParticipant)),
      hasMedia: hasMediaContent(quotedMessage),
      stanzaId: contextInfo?.stanzaId,
      rawMessage: quotedMessage,
    };
  }

  // ── 5. hasMedia ───────────────────────────────────────────────────────────
  const hasMedia = hasMediaContent(rawMsg);

  return { messageType, text, hasMedia, mentionedIds, quoted };
}
