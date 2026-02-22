/**
 * whatsappParser.test.ts
 *
 * Dynamic fixture-based tests for `parseWhatsAppMessage()`.
 *
 * HOW IT WORKS:
 * 1. On bot shutdown (Ctrl+C), `index.ts` writes one fixture JSON per unique
 *    messageType to `test/fixtures/wa_messages/<messageType>.json`.
 * 2. This test file auto-discovers all JSON files in that folder at runtime.
 * 3. For each fixture:
 *    a. parseWhatsAppMessage() must NOT throw.
 *    b. messageType must NOT be 'unknown'.
 *    c. If the fixture has a quoted message, quoted.body must be a string.
 *    d. If the fixture has a media payload, hasMedia must be true.
 *
 * ADD SPECIFIC ASSERTIONS below the dynamic block for types that need
 * precise field-level checks (see the examples at the bottom of this file).
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve, basename } from 'path';
import { parseWhatsAppMessage } from '../src/providers/whatsappParser';

const FIXTURE_DIR = resolve('./test/fixtures/wa_messages');
const BOT_JID = '6281999000111:15@s.whatsapp.net'; // hypothetical bot JID

// ─── Canonical media message types as recognised by getContentType() ────────
const MEDIA_TYPES = new Set([
  'imageMessage', 'videoMessage', 'audioMessage',
  'documentMessage', 'stickerMessage',
]);

// ─── Helper: load all JSON fixtures from the folder ──────────────────────────
function loadFixtures(): Array<{ name: string; raw: any }> {
  let files: string[];
  try {
    files = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return []; // folder doesn't exist yet — no fixtures to run
  }
  return files.map(f => ({
    name: basename(f, '.json'),
    raw: JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf-8')),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC: one test per fixture file
// These run for EVERY fixture automatically — no manual registration needed.
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWhatsAppMessage — dynamic fixture coverage', () => {
  const fixtures = loadFixtures();

  if (fixtures.length === 0) {
    test('(no fixtures found — run the bot then Ctrl+C to generate them)', () => {
      // Soft-pass so CI doesn't fail on a fresh checkout with an empty fixture dir
      expect(true).toBe(true);
    });
  }

  for (const { name, raw } of fixtures) {
    test(`${name} — must parse without error`, () => {
      let result: ReturnType<typeof parseWhatsAppMessage>;
      expect(() => {
        result = parseWhatsAppMessage(raw, BOT_JID);
      }).not.toThrow();

      // messageType must never be 'unknown' for a real fixture
      expect(result!.messageType).not.toBe('unknown');

      // text must always be a string (never null/undefined)
      expect(typeof result!.text).toBe('string');

      // mentionedIds must always be an array
      expect(Array.isArray(result!.mentionedIds)).toBe(true);

      // If the raw message contains a known media type key, hasMedia must be true
      const msg = raw?.message ?? {};
      const hasSomeMediaKey = MEDIA_TYPES.has(result!.messageType);
      if (hasSomeMediaKey) {
        expect(result!.hasMedia).toBe(true);
      }

      // If quoted is present, its fields should all be well-typed
      if (result!.quoted) {
        expect(typeof result!.quoted.body).toBe('string');
        expect(typeof result!.quoted.senderId).toBe('string');
        expect(typeof result!.quoted.messageType).toBe('string');
        expect(typeof result!.quoted.hasMedia).toBe('boolean');
        expect(typeof result!.quoted.fromMe).toBe('boolean');
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SPECIFIC: precise assertions for well-known types
// These live here permanently and survive fixture regeneration.
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWhatsAppMessage — specific type assertions', () => {
  // Load individual fixtures by canonical messageType name
  function load(name: string): any | null {
    const fp = join(FIXTURE_DIR, `${name}.json`);
    if (!existsSync(fp)) return null;
    try { return JSON.parse(readFileSync(fp, 'utf-8')); } catch { return null; }
  }

  test('conversation — text equals message body', () => {
    const raw = load('conversation');
    if (!raw) return; // skip if not yet generated
    const r = parseWhatsAppMessage(raw, BOT_JID);
    expect(r.messageType).toBe('conversation');
    expect(r.text).toBe(raw.message?.conversation ?? '');
    expect(r.hasMedia).toBe(false);
  });

  test('imageMessage — text equals caption', () => {
    const raw = load('imageMessage');
    if (!raw) return;
    const r = parseWhatsAppMessage(raw, BOT_JID);
    expect(r.messageType).toBe('imageMessage');
    expect(r.text).toBe(raw.message?.imageMessage?.caption ?? '');
    expect(r.hasMedia).toBe(true);
  });

  test('audioMessage — no text, hasMedia = true', () => {
    const raw = load('audioMessage');
    if (!raw) return;
    const r = parseWhatsAppMessage(raw, BOT_JID);
    expect(r.messageType).toBe('audioMessage');
    expect(r.text).toBe('');
    expect(r.hasMedia).toBe(true);
  });

  test('stickerMessage — no text, hasMedia = true', () => {
    const raw = load('stickerMessage');
    if (!raw) return;
    const r = parseWhatsAppMessage(raw, BOT_JID);
    expect(r.messageType).toBe('stickerMessage');
    expect(r.text).toBe('');
    expect(r.hasMedia).toBe(true);
  });

  test('documentMessage — no text, hasMedia = true', () => {
    const raw = load('documentMessage');
    if (!raw) return;
    const r = parseWhatsAppMessage(raw, BOT_JID);
    expect(r.messageType).toBe('documentMessage');
    expect(r.hasMedia).toBe(true);
  });

  test('extendedTextMessage (reply) — quoted.body is populated', () => {
    const raw = load('extendedTextMessage');
    if (!raw) return;
    const r = parseWhatsAppMessage(raw, BOT_JID);
    expect(r.messageType).toBe('extendedTextMessage');
    expect(r.quoted).toBeDefined();
    expect(typeof r.quoted!.body).toBe('string');
  });

  test('viewOnceMessageV2 — unwrapped to inner type, hasMedia = true', () => {
    const raw = load('viewOnceMessageV2');
    if (!raw) return;
    const r = parseWhatsAppMessage(raw, BOT_JID);
    // must be unwrapped to imageMessage or videoMessage, NOT viewOnceMessageV2
    expect(r.messageType).not.toBe('viewOnceMessageV2');
    expect(r.hasMedia).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EDGE CASES: fixed-input tests, no fixture files needed
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWhatsAppMessage — edge cases', () => {
  test('empty message object does not throw', () => {
    expect(() => parseWhatsAppMessage({ key: { remoteJid: 'x@s.whatsapp.net', id: 'y', fromMe: false } } as any, null)).not.toThrow();
  });

  test('null message body yields text="" and hasMedia=false', () => {
    const r = parseWhatsAppMessage({ key: { remoteJid: 'x@s.whatsapp.net', id: 'y', fromMe: false }, message: null } as any, null);
    expect(r.text).toBe('');
    expect(r.hasMedia).toBe(false);
    expect(r.quoted).toBeUndefined();
  });

  test('fromMe is false when botUserId is null', () => {
    const raw = {
      key: { remoteJid: '628x@s.whatsapp.net', id: 'z', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'hi',
          contextInfo: {
            stanzaId: 'old', participant: '62800@s.whatsapp.net',
            quotedMessage: { conversation: 'hey' },
          },
        },
      },
    };
    const r = parseWhatsAppMessage(raw as any, null);
    expect(r.quoted!.fromMe).toBe(false);
  });

  test('fromMe is true when botUserId (PN JID) matches quotedParticipant (PN JID)', () => {
    const raw = {
      key: { remoteJid: 'group@g.us', id: 'abc', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'hello',
          contextInfo: {
            stanzaId: 'bot-msg-1',
            participant: '6281999000111@s.whatsapp.net',
            quotedMessage: { conversation: 'I am working!' },
          },
        },
      },
    };
    // BOT_JID includes device suffix — normalizeJid strips it before comparing
    const r = parseWhatsAppMessage(raw as any, BOT_JID);
    expect(r.quoted!.fromMe).toBe(true);
    expect(r.quoted!.stanzaId).toBe('bot-msg-1');
  });

  test('fromMe is FALSE when botUserId (PN JID) vs quotedParticipant (LID) — provider must apply fallback', () => {
    // This is the WhatsApp V7 LID mismatch scenario:
    // - Bot's sock.user.id = phone-number JID ("628xxx@s.whatsapp.net:0")
    // - contextInfo.participant = LID ("265841933336713@lid")
    // The parser correctly returns fromMe=false here; the WhatsAppProvider
    // must then fix it via the sentMessageIds set or DB lookup.
    const raw = {
      key: { remoteJid: 'group@g.us', id: 'user-msg-2', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'hello',
          contextInfo: {
            stanzaId: 'bot-msg-lid-1',
            participant: '265841933336713@lid',
            quotedMessage: { conversation: 'Yes, I am working!' },
          },
        },
      },
    };
    // BOT_JID is phone-number format, NOT matching the LID
    const r = parseWhatsAppMessage(raw as any, BOT_JID);
    // Parser alone cannot resolve the LID mismatch — fromMe is false
    expect(r.quoted!.fromMe).toBe(false);
    // stanzaId is available for the provider to do the fallback lookup
    expect(r.quoted!.stanzaId).toBe('bot-msg-lid-1');
    // The quoted body is still correctly extracted
    expect(r.quoted!.body).toBe('Yes, I am working!');
  });
});
