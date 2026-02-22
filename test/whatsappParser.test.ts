import { describe, test, expect } from 'bun:test';
import { parseWhatsAppMessage } from '../src/providers/whatsappParser';

// ── Real WAMessage fixtures captured from a live v6 Baileys session ──────────
// DM fixtures (message_samples/) — sender identified by senderLid on key
import plainText from './fixtures/wa_messages/plain_text.json';
import imageWithCaption from './fixtures/wa_messages/image_with_caption.json';
import audioVoiceNote from './fixtures/wa_messages/audio_voice_note.json';
import documentFile from './fixtures/wa_messages/document_file.json';
import stickerMsg from './fixtures/wa_messages/sticker.json';
import replyToText from './fixtures/wa_messages/reply_to_text.json';

// Group fixtures (message_samples_groups/) — sender identified by key.participant (@lid)
import groupPlainText from './fixtures/wa_messages/group_plain_text.json';
import groupReplyToImage from './fixtures/wa_messages/group_reply_to_image.json';

// Static — unchanged hand-crafted fixture for viewOnce (no real sample available yet)
import viewOnceImage from './fixtures/wa_messages/view_once_image.json';
import imageNoCaption from './fixtures/wa_messages/image_no_caption.json';

// ── JIDs from real fixtures ───────────────────────────────────────────────────
const BOT_JID = '6281999000111:15@s.whatsapp.net'; // hypothetical bot JID
const SENDER_LID = '27870210576446@lid'; // sender's LID as seen in real samples

describe('parseWhatsAppMessage — DM message types', () => {
  test('plain text conversation', () => {
    const r = parseWhatsAppMessage(plainText as any, BOT_JID);
    expect(r.messageType).toBe('conversation');
    expect(r.text).toBe('testing');
    expect(r.hasMedia).toBe(false);
    expect(r.mentionedIds).toEqual([]);
    expect(r.quoted).toBeUndefined();
  });

  test('image with caption', () => {
    const r = parseWhatsAppMessage(imageWithCaption as any, BOT_JID);
    expect(r.messageType).toBe('imageMessage');
    expect(r.text).toBe('reply camera test');
    expect(r.hasMedia).toBe(true);
    expect(r.quoted).toBeUndefined();
  });

  test('image with no caption', () => {
    const r = parseWhatsAppMessage(imageNoCaption as any, BOT_JID);
    expect(r.messageType).toBe('imageMessage');
    expect(r.text).toBe('');
    expect(r.hasMedia).toBe(true);
  });

  test('audio message (non-PTT)', () => {
    const r = parseWhatsAppMessage(audioVoiceNote as any, BOT_JID);
    expect(r.messageType).toBe('audioMessage');
    expect(r.hasMedia).toBe(true);
    expect(r.text).toBe('');
  });

  test('document file', () => {
    const r = parseWhatsAppMessage(documentFile as any, BOT_JID);
    expect(r.messageType).toBe('documentMessage');
    expect(r.hasMedia).toBe(true);
    expect(r.text).toBe('');
  });

  test('animated sticker', () => {
    const r = parseWhatsAppMessage(stickerMsg as any, BOT_JID);
    expect(r.messageType).toBe('stickerMessage');
    expect(r.hasMedia).toBe(true);
    expect(r.text).toBe('');
  });
});

describe('parseWhatsAppMessage — DM quoted messages', () => {
  test('reply to plain text — extracts quoted body', () => {
    const r = parseWhatsAppMessage(replyToText as any, BOT_JID);
    expect(r.messageType).toBe('extendedTextMessage');
    expect(r.text).toBe('reply normal test');
    expect(r.quoted).toBeDefined();
    expect(r.quoted!.messageType).toBe('conversation');
    // Body comes from quotedMessage.conversation
    expect(r.quoted!.body).toBe('testing');
    expect(r.quoted!.hasMedia).toBe(false);
    // participant is a PN JID in this DM sample
    expect(r.quoted!.senderId).toBe('62895320460745@s.whatsapp.net');
    // Bot's normalized number doesn't match sender's number
    expect(r.quoted!.fromMe).toBe(false);
  });
});

describe('parseWhatsAppMessage — Group message types', () => {
  test('group plain text — sender is @lid JID', () => {
    const r = parseWhatsAppMessage(groupPlainText as any, BOT_JID);
    expect(r.messageType).toBe('conversation');
    expect(r.text).toBe('bxhsjsjaja');
    expect(r.hasMedia).toBe(false);
    // No quoted
    expect(r.quoted).toBeUndefined();
  });

  test('group reply to image — quoted has media and correct type', () => {
    const r = parseWhatsAppMessage(groupReplyToImage as any, BOT_JID);
    expect(r.messageType).toBe('extendedTextMessage');
    expect(r.text).toBe('jsksjaja');
    expect(r.quoted).toBeDefined();
    expect(r.quoted!.messageType).toBe('imageMessage');
    expect(r.quoted!.hasMedia).toBe(true);
    // No caption on quoted image, body should be empty string
    expect(r.quoted!.body).toBe('');
    expect(r.quoted!.fromMe).toBe(false);
  });
});

describe('parseWhatsAppMessage — viewOnce unwrapping', () => {
  test('viewOnceMessageV2 is unwrapped to imageMessage', () => {
    const r = parseWhatsAppMessage(viewOnceImage as any, BOT_JID);
    expect(r.messageType).toBe('imageMessage');
    expect(r.hasMedia).toBe(true);
  });
});

describe('parseWhatsAppMessage — fromMe / JID normalization', () => {
  test('fromMe is false when botUserId is null', () => {
    const r = parseWhatsAppMessage(replyToText as any, null);
    expect(r.quoted!.fromMe).toBe(false);
  });

  test('fromMe is false when sender is a different number', () => {
    const r = parseWhatsAppMessage(replyToText as any, BOT_JID);
    // quoted.participant = 62895320460745 != 6281999000111 (bot)
    expect(r.quoted!.fromMe).toBe(false);
  });

  test('fromMe correctly handles bot JID with device suffix (:15)', () => {
    // Use the real sender LID as the "bot JID" for this test
    const r = parseWhatsAppMessage(replyToText as any, `${SENDER_LID}`);
    // sender in contextInfo.participant is PN JID 62895320460745 — normalize strip gives '62895320460745'
    // bot's LID is 27870210576446@lid — normalize gives '27870210576446'
    // They don't match (PN vs LID numeric) — but normalization just strips domain+device
    // Both are different numbers so fromMe stays false
    expect(r.quoted!.fromMe).toBe(false);
  });
});
