import { WAMessage, proto, getContentType } from '@whiskeysockets/baileys';

export interface ParsedWAMessage {
  messageType: string;
  text: string;
  hasMedia: boolean;
  mentionedIds: string[];
  quoted: ParsedQuotedMessage | undefined;
}

export type LidResolver = (jid: string) => Promise<string>;

export interface ParsedQuotedMessage {
  messageType: string;
  body: string;
  senderId: string;
  fromMe: boolean;
  hasMedia: boolean;
  stanzaId: string | null | undefined;
  rawMessage: proto.IMessage;
}

type MessageRecord = Record<string, unknown>;
type MessageContent = {
  caption?: string | null;
  text?: string | null;
  conversation?: string | null;
  contentText?: string | null;
  selectedDisplayText?: string | null;
  title?: string | null;
  contextInfo?: proto.IContextInfo | null;
  singleSelectReply?: { selectedRowId?: string | null } | null;
  selectedButtonId?: string | null;
};

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

const WRAPPER_TYPES = new Set([
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'ephemeralMessage',
]);

function asRecord(value: unknown): MessageRecord | undefined {
  return value && typeof value === 'object' ? (value as MessageRecord) : undefined;
}

function asMessageContent(value: unknown): MessageContent | undefined {
  return value && typeof value === 'object' ? (value as MessageContent) : undefined;
}

function getMessagePart(message: proto.IMessage | null | undefined, type: string): unknown {
  return asRecord(message)?.[type];
}

function getNestedMessage(content: unknown): proto.IMessage | undefined {
  const nested = asRecord(content)?.message;
  return nested && typeof nested === 'object' ? (nested as proto.IMessage) : undefined;
}

function unwrapMessage(message: proto.IMessage | null | undefined): { type: string; content: unknown } {
  let currentType = (message ? getContentType(message) : null) ?? 'unknown';
  let currentContent = getMessagePart(message, currentType);

  while (WRAPPER_TYPES.has(currentType)) {
    const innerMessage = getNestedMessage(currentContent);
    if (!innerMessage) break;

    const innerType = getContentType(innerMessage);
    if (!innerType) break;

    currentType = innerType;
    currentContent = getMessagePart(innerMessage, innerType);
  }

  return { type: currentType, content: currentContent };
}

export function getFileLength(msgObj: proto.IMessage | null | undefined): number | null {
  if (!msgObj) return null;

  const { content } = unwrapMessage(msgObj);
  const fileLength = asRecord(content)?.fileLength;
  if (fileLength === undefined || fileLength === null || fileLength === 0) {
    return null;
  }

  return Number(fileLength);
}

export const normalizeJid = (jid?: string | null): string =>
  jid ? jid.split('@')[0].split(':')[0] : '';

function hasMediaContent(msgObj: proto.IMessage | null | undefined): boolean {
  if (!msgObj) return false;
  return MEDIA_TYPES.has(unwrapMessage(msgObj).type);
}

export async function parseWhatsAppMessage(
  msg: WAMessage,
  botUserId: string | null | undefined,
  botLid?: string | null,
  resolveLid?: LidResolver,
): Promise<ParsedWAMessage> {
  const rawMsg = msg.message;
  const { type: messageType, content: messageContent } = unwrapMessage(rawMsg);
  const messageData = asMessageContent(messageContent);

  const text =
    rawMsg?.conversation ||
    messageData?.caption ||
    messageData?.text ||
    (messageType === 'listResponseMessage' ? messageData?.singleSelectReply?.selectedRowId || '' : '') ||
    (messageType === 'buttonsResponseMessage' ? messageData?.selectedButtonId || '' : '') ||
    '';

  const contextInfo: proto.IContextInfo | null | undefined =
    rawMsg?.extendedTextMessage?.contextInfo ||
    rawMsg?.imageMessage?.contextInfo ||
    rawMsg?.videoMessage?.contextInfo ||
    rawMsg?.audioMessage?.contextInfo ||
    rawMsg?.documentMessage?.contextInfo ||
    rawMsg?.stickerMessage?.contextInfo ||
    messageData?.contextInfo ||
    null;

  let mentionedIds: string[] = contextInfo?.mentionedJid ?? [];
  if (resolveLid) {
    mentionedIds = await Promise.all(mentionedIds.map(resolveLid));
  }

  let quoted: ParsedQuotedMessage | undefined;
  const quotedMessage = contextInfo?.quotedMessage;
  let quotedParticipant = contextInfo?.participant;

  if (resolveLid && quotedParticipant) {
    quotedParticipant = await resolveLid(quotedParticipant);
  }

  if (quotedMessage && quotedParticipant) {
    let { type: quotedType, content: quotedContent } = unwrapMessage(quotedMessage);

    if (quotedType === 'productMessage') {
      const productInnerType = getContentType(quotedContent as proto.IMessage);
      if (productInnerType) {
        quotedType = productInnerType;
        quotedContent = asRecord(quotedContent)?.[productInnerType];
      }
    }

    const normalizedQuotedContent =
      typeof quotedContent === 'string'
        ? ({ text: quotedContent } as MessageContent)
        : asMessageContent(quotedContent);

    const body =
      normalizedQuotedContent?.text ||
      normalizedQuotedContent?.caption ||
      normalizedQuotedContent?.conversation ||
      normalizedQuotedContent?.contentText ||
      normalizedQuotedContent?.selectedDisplayText ||
      normalizedQuotedContent?.title ||
      '';

    quoted = {
      messageType: quotedType,
      body,
      senderId: quotedParticipant,
      fromMe:
        (normalizeJid(botUserId) !== '' && normalizeJid(botUserId) === normalizeJid(quotedParticipant)) ||
        (normalizeJid(botLid) !== '' && normalizeJid(botLid) === normalizeJid(quotedParticipant)),
      hasMedia: hasMediaContent(quotedMessage),
      stanzaId: contextInfo?.stanzaId,
      rawMessage: quotedMessage,
    };
  }

  return {
    messageType,
    text,
    hasMedia: hasMediaContent(rawMsg),
    mentionedIds,
    quoted,
  };
}
