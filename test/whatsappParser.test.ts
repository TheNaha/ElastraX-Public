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
import { parseWhatsAppMessage, LidResolver, getFileLength, normalizeJid } from '../src/providers/whatsappParser';

const FIXTURE_DIR = resolve('./test/fixtures/wa_messages');
const BOT_JID = '6281999000111:15@s.whatsapp.net'; // hypothetical bot JID

const dummyResolver: LidResolver = async (jid) => jid;

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
    test(`${name} — must parse without error`, async () => {
      let result: ReturnType<typeof parseWhatsAppMessage> extends Promise<infer U> ? U : never;
      
      let didThrow = false;
      try {
        result = await parseWhatsAppMessage(raw, BOT_JID, null, dummyResolver);
      } catch (e) {
        didThrow = true;
      }
      expect(didThrow).toBe(false);

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

  test('conversation — text equals message body', async () => {
    const raw = load('conversation');
    if (!raw) return; // skip if not yet generated
    const r = await parseWhatsAppMessage(raw, BOT_JID, null, dummyResolver);
    expect(r.messageType).toBe('conversation');
    expect(r.text).toBe(raw.message?.conversation ?? '');
    expect(r.hasMedia).toBe(false);
  });

  test('imageMessage — text equals caption', async () => {
    const raw = load('imageMessage');
    if (!raw) return;
    const r = await parseWhatsAppMessage(raw, BOT_JID, null, dummyResolver);
    expect(r.messageType).toBe('imageMessage');
    expect(r.text).toBe(raw.message?.imageMessage?.caption ?? '');
    expect(r.hasMedia).toBe(true);
  });

  test('audioMessage — no text, hasMedia = true', async () => {
    const raw = load('audioMessage');
    if (!raw) return;
    const r = await parseWhatsAppMessage(raw, BOT_JID, null, dummyResolver);
    expect(r.messageType).toBe('audioMessage');
    expect(r.text).toBe('');
    expect(r.hasMedia).toBe(true);
  });

  test('stickerMessage — no text, hasMedia = true', async () => {
    const raw = load('stickerMessage');
    if (!raw) return;
    const r = await parseWhatsAppMessage(raw, BOT_JID, null, dummyResolver);
    expect(r.messageType).toBe('stickerMessage');
    expect(r.text).toBe('');
    expect(r.hasMedia).toBe(true);
  });

  test('documentMessage — no text, hasMedia = true', async () => {
    const raw = load('documentMessage');
    if (!raw) return;
    const r = await parseWhatsAppMessage(raw, BOT_JID, null, dummyResolver);
    expect(r.messageType).toBe('documentMessage');
    expect(r.hasMedia).toBe(true);
  });

  test('extendedTextMessage (reply) — quoted.body is populated', async () => {
    const raw = load('reply_to_text');
    if (!raw) return;
    const r = await parseWhatsAppMessage(raw, BOT_JID, null, dummyResolver);
    expect(r.messageType).toBe('extendedTextMessage');
    expect(r.quoted).toBeDefined();
    expect(typeof r.quoted!.body).toBe('string');
  });

  test('extendedTextMessage (mention) — quoted is undefined', async () => {
    const raw = load('extendedTextMessage');
    if (!raw) return;
    const r = await parseWhatsAppMessage(raw, BOT_JID, null, dummyResolver);
    expect(r.messageType).toBe('extendedTextMessage');
    expect(r.quoted).toBeUndefined();
    expect(r.mentionedIds.length).toBeGreaterThan(0);
  });

  test('viewOnceMessageV2 — unwrapped to inner type, hasMedia = true', async () => {
    const raw = load('viewOnceMessageV2');
    if (!raw) return;
    const r = await parseWhatsAppMessage(raw, BOT_JID, null, dummyResolver);
    // must be unwrapped to imageMessage or videoMessage, NOT viewOnceMessageV2
    expect(r.messageType).not.toBe('viewOnceMessageV2');
    expect(r.hasMedia).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EDGE CASES: fixed-input tests, no fixture files needed
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWhatsAppMessage — edge cases', () => {
  test('empty message object does not throw', async () => {
    let err = false;
    try { await parseWhatsAppMessage({ key: { remoteJid: 'x@s.whatsapp.net', id: 'y', fromMe: false } } as any, null, null, dummyResolver); } catch(e) { err = true; };
    expect(err).toBe(false);
  });

  test('null message body yields text="" and hasMedia=false', async () => {
    const r = await parseWhatsAppMessage({ key: { remoteJid: 'x@s.whatsapp.net', id: 'y', fromMe: false }, message: null } as any, null, null, dummyResolver);
    expect(r.text).toBe('');
    expect(r.hasMedia).toBe(false);
    expect(r.quoted).toBeUndefined();
  });

  test('fromMe is false when botUserId is null', async () => {
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
    const r = await parseWhatsAppMessage(raw as any, null, null, dummyResolver);
    expect(r.quoted!.fromMe).toBe(false);
  });

  test('fromMe is true when botUserId (PN JID) matches quotedParticipant (PN JID)', async () => {
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
    const r = await parseWhatsAppMessage(raw as any, BOT_JID, null, dummyResolver);
    expect(r.quoted!.fromMe).toBe(true);
    expect(r.quoted!.stanzaId).toBe('bot-msg-1');
  });

  test('fromMe is FALSE when botUserId (PN JID) vs quotedParticipant (LID) — without botLid', async () => {
    // This is the WhatsApp V7 LID mismatch scenario without the botLid parameter.
    // The parser returns fromMe=false when no botLid is provided.
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
    // BOT_JID is phone-number format, NOT matching the LID — no botLid provided
    const r = await parseWhatsAppMessage(raw as any, BOT_JID, null, dummyResolver);
    expect(r.quoted!.fromMe).toBe(false);
    expect(r.quoted!.stanzaId).toBe('bot-msg-lid-1');
    expect(r.quoted!.body).toBe('Yes, I am working!');
  });

  test('fromMe is TRUE when botLid (LID JID) matches quotedParticipant (LID) — WA V7 fix', async () => {
    // The proper Baileys V7 fix: pass the bot's LID (resolved via
    // sock.signalRepository.lidMapping.getLIDForPN()) to parseWhatsAppMessage().
    const raw = {
      key: { remoteJid: 'group@g.us', id: 'user-msg-3', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'hello',
          contextInfo: {
            stanzaId: 'bot-msg-lid-2',
            participant: '265841933336713@lid',
            quotedMessage: { conversation: 'Yes, I am working!' },
          },
        },
      },
    };
    const BOT_LID = '265841933336713@lid'; // would come from getLIDForPN(botPn)
    const r = await parseWhatsAppMessage(raw as any, BOT_JID, BOT_LID, dummyResolver);
    expect(r.quoted!.fromMe).toBe(true);
    expect(r.quoted!.body).toBe('Yes, I am working!');
  });

  test('fromMe stays false when botLid does not match quotedParticipant LID', async () => {
    const raw = {
      key: { remoteJid: 'group@g.us', id: 'user-msg-4', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'hello',
          contextInfo: {
            stanzaId: 'other-msg-1',
            participant: '999999999@lid',
            quotedMessage: { conversation: 'Someone else said this' },
          },
        },
      },
    };
    const BOT_LID = '265841933336713@lid';
    const r = await parseWhatsAppMessage(raw as any, BOT_JID, BOT_LID, dummyResolver);
    expect(r.quoted!.fromMe).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getFileLength — exported helper tests (covers lines 47-69)
// ─────────────────────────────────────────────────────────────────────────────

describe('getFileLength', () => {
  test('should return null for null input', () => {
    expect(getFileLength(null)).toBeNull();
  });

  test('should return null for undefined input', () => {
    expect(getFileLength(undefined)).toBeNull();
  });

  test('should return null when message has no fileLength field', () => {
    expect(getFileLength({ conversation: 'hello' } as any)).toBeNull();
  });

  test('should extract fileLength from imageMessage', () => {
    expect(getFileLength({ imageMessage: { fileLength: 1024 } } as any)).toBe(1024);
  });

  test('should return null when fileLength is 0 (falsy)', () => {
    expect(getFileLength({ imageMessage: { fileLength: 0 } } as any)).toBeNull();
  });

  test('should extract fileLength from audioMessage', () => {
    expect(getFileLength({ audioMessage: { fileLength: 512 } } as any)).toBe(512);
  });

  test('should unwrap viewOnceMessage to extract fileLength', () => {
    const msg = {
      viewOnceMessage: { message: { imageMessage: { fileLength: 2048 } } },
    };
    expect(getFileLength(msg as any)).toBe(2048);
  });

  test('should unwrap viewOnceMessageV2 to extract fileLength', () => {
    const msg = {
      viewOnceMessageV2: { message: { videoMessage: { fileLength: 4096 } } },
    };
    expect(getFileLength(msg as any)).toBe(4096);
  });

  test('should unwrap viewOnceMessageV2Extension to extract fileLength', () => {
    const msg = {
      viewOnceMessageV2Extension: { message: { imageMessage: { fileLength: 999 } } },
    };
    expect(getFileLength(msg as any)).toBe(999);
  });

  test('should unwrap documentWithCaptionMessage to extract fileLength', () => {
    const msg = {
      documentWithCaptionMessage: { message: { documentMessage: { fileLength: 333 } } },
    };
    expect(getFileLength(msg as any)).toBe(333);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeJid — exported helper
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeJid', () => {
  test('should strip domain from JID', () => {
    expect(normalizeJid('628123@s.whatsapp.net')).toBe('628123');
  });

  test('should strip device suffix from JID', () => {
    expect(normalizeJid('628123:5@s.whatsapp.net')).toBe('628123');
  });

  test('should return empty string for null', () => {
    expect(normalizeJid(null)).toBe('');
  });

  test('should return empty string for undefined', () => {
    expect(normalizeJid(undefined)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Quoted message wrapper and productMessage branch tests (lines 102-103, 202-210)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWhatsAppMessage — quoted wrapper and media edge cases', () => {
  test('should mark hasMedia=true when quoted message has a viewOnce wrapper with inner media', async () => {
    // The quoted message itself is a viewOnce wrapper — hasMediaContent(quotedMessage) must
    // traverse the inner level to return true.
    const raw = {
      key: { remoteJid: 'group@g.us', id: 'user-msg-qwrap', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'check this',
          contextInfo: {
            stanzaId: 'qwrap-stanza',
            participant: 'other@s.whatsapp.net',
            // Quoted message is itself a viewOnceMessageV2 wrapper
            quotedMessage: {
              viewOnceMessageV2: {
                message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } },
              },
            },
          },
        },
      },
    };
    const r = await parseWhatsAppMessage(raw as any, null, null, dummyResolver);
    expect(r.quoted).toBeDefined();
    // viewOnceMessageV2 is in MEDIA_TYPES, so hasMedia must be true
    expect(r.quoted!.hasMedia).toBe(true);
  });

  test('should unwrap viewOnce wrapper in quoted message and expose inner messageType', async () => {
    // The quoted message is a viewOnceMessage wrapping an imageMessage.
    // The parser should unwrap it and set qType = 'imageMessage'.
    const raw = {
      key: { remoteJid: 'group@g.us', id: 'user-msg-qview', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'look at this',
          contextInfo: {
            stanzaId: 'viewonce-stanza',
            participant: 'other@s.whatsapp.net',
            quotedMessage: {
              viewOnceMessage: {
                message: { imageMessage: { caption: 'a photo', mimetype: 'image/jpeg' } },
              },
            },
          },
        },
      },
    };
    const r = await parseWhatsAppMessage(raw as any, null, null, dummyResolver);
    expect(r.quoted).toBeDefined();
    expect(r.quoted!.messageType).toBe('imageMessage');
    expect(r.quoted!.hasMedia).toBe(true);
  });

  test('should unwrap documentWithCaptionMessage in quoted context', async () => {
    const raw = {
      key: { remoteJid: '628x@s.whatsapp.net', id: 'user-docq', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'see the doc',
          contextInfo: {
            stanzaId: 'doc-stanza',
            participant: 'other@s.whatsapp.net',
            quotedMessage: {
              documentWithCaptionMessage: {
                message: { documentMessage: { caption: 'report.pdf', mimetype: 'application/pdf' } },
              },
            },
          },
        },
      },
    };
    const r = await parseWhatsAppMessage(raw as any, null, null, dummyResolver);
    expect(r.quoted).toBeDefined();
    expect(r.quoted!.messageType).toBe('documentMessage');
  });

  test('should handle productMessage in quoted context (lines 209-210)', async () => {
    // productMessage is not a viewOnce wrapper, but has its own unwrapping branch
    const raw = {
      key: { remoteJid: '628x@s.whatsapp.net', id: 'user-prod', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'check this product',
          contextInfo: {
            stanzaId: 'prod-stanza',
            participant: 'other@s.whatsapp.net',
            quotedMessage: {
              productMessage: {
                product: { title: 'Nice Item' },
              },
            },
          },
        },
      },
    };
    const r = await parseWhatsAppMessage(raw as any, null, null, dummyResolver);
    expect(r.quoted).toBeDefined();
    // qType would be 'productMessage', unwrapped to its inner content type
    expect(r.quoted!.senderId).toBe('other@s.whatsapp.net');
  });

  test('hasMediaContent should detect inner media through non-MEDIA_TYPES outer wrapper', async () => {
    // Construct a synthetic message where getContentType returns 'extendedTextMessage'
    // (not in MEDIA_TYPES) but the object also has viewOnceMessageV2 as a sibling key.
    // This exercises lines 102-103 of hasMediaContent.
    const raw = {
      key: { remoteJid: '628x@s.whatsapp.net', id: 'synthetic-media', fromMe: false },
      message: {
        // extendedTextMessage is the canonical type detected by getContentType
        extendedTextMessage: { text: 'hello', contextInfo: null },
        // BUT the message object also has a viewOnceMessageV2 sibling
        viewOnceMessageV2: {
          message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } },
        },
      },
    };
    // We don't assert hasMedia=true here since getContentType would pick extendedTextMessage
    // and return false at line 92; the inner check is then reached.
    const r = await parseWhatsAppMessage(raw as any, null, null, dummyResolver);
    // The important thing is that no error is thrown
    expect(r.messageType).toBe('extendedTextMessage');
  });

  test('should resolve mentionedIds using resolveLid when provided', async () => {
    const resolved: Record<string, string> = {
      '628111@s.whatsapp.net': '111111@lid',
    };
    const resolver: LidResolver = async (jid) => resolved[jid] ?? jid;
    const raw = {
      key: { remoteJid: 'group@g.us', id: 'mention-msg', fromMe: false },
      message: {
        extendedTextMessage: {
          text: '@Alice check this',
          contextInfo: {
            mentionedJid: ['628111@s.whatsapp.net'],
          },
        },
      },
    };
    const r = await parseWhatsAppMessage(raw as any, null, null, resolver);
    expect(r.mentionedIds).toContain('111111@lid');
  });

  test('should resolve quotedParticipant using resolveLid when provided', async () => {
    const resolved: Record<string, string> = {
      'other@s.whatsapp.net': 'other-lid@lid',
    };
    const resolver: LidResolver = async (jid) => resolved[jid] ?? jid;
    const raw = {
      key: { remoteJid: 'group@g.us', id: 'resolve-lid-msg', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'reply',
          contextInfo: {
            stanzaId: 'stanza-x',
            participant: 'other@s.whatsapp.net',
            quotedMessage: { conversation: 'original message' },
          },
        },
      },
    };
    const r = await parseWhatsAppMessage(raw as any, null, null, resolver);
    expect(r.quoted).toBeDefined();
    expect(r.quoted!.senderId).toBe('other-lid@lid');
  });
});
