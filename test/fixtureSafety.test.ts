import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertSafeWhatsAppFixtureFile,
  sanitizeWhatsAppFixture,
  validateWhatsAppFixture,
  validateWhatsAppFixtureJson,
  type FixtureSafetyRule,
} from './helpers/fixtureSafety';

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures', 'wa_messages');

function rulesFor(value: unknown): FixtureSafetyRule[] {
  return validateWhatsAppFixture(value).map(({ rule }) => rule);
}

describe('WhatsApp fixture safety', () => {
  test('all parser fixtures pass strict validation', () => {
    const files = readdirSync(FIXTURE_DIR).filter(file => file.endsWith('.json')).sort();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const path = resolve(FIXTURE_DIR, file);
      const fixture = JSON.parse(readFileSync(path, 'utf8'));
      expect(validateWhatsAppFixture(fixture)).toEqual([]);
      expect(() => assertSafeWhatsAppFixtureFile(path)).not.toThrow();
    }
  });

  test('rejects every prohibited fixture data class', () => {
    const cases: Array<{ fixture: unknown; rule: FixtureSafetyRule }> = [
      { fixture: { key: { id: '628123456789' } }, rule: 'phone-shaped-id' },
      { fixture: { key: { remoteJid: '628123456789@s.whatsapp.net' } }, rule: 'phone-shaped-id' },
      { fixture: { phoneNumber: '+62 812-3456-7890' }, rule: 'phone-shaped-id' },
      { fixture: { message: { locationMessage: { degreesLatitude: -6.2 } } }, rule: 'coordinates' },
      { fixture: { message: { imageMessage: { url: 'https://example.invalid/media' } } }, rule: 'url' },
      { fixture: { link: 'example.invalid/path' }, rule: 'url' },
      { fixture: { message: { imageMessage: { mediaKey: 'nonempty-key-material' } } }, rule: 'crypto-key-or-secret' },
      { fixture: { message: { messageContextInfo: { messageSecret: 'nonempty-secret' } } }, rule: 'crypto-key-or-secret' },
      { fixture: { mediaData: { localPath: '/private/media.jpg' } }, rule: 'media-metadata' },
      { fixture: { message: { contactMessage: { vcard: 'BEGIN:VCARD\nFN:Example\nEND:VCARD' } } }, rule: 'vcard' },
      { fixture: { message: { conversation: 'private message body' } }, rule: 'message-text' },
      { fixture: { pushName: 'Real Person' }, rule: 'unsafe-name' },
    ];

    for (const { fixture, rule } of cases) {
      expect(rulesFor(fixture)).toContain(rule);
    }
  });

  test('allows structural fields and explicitly empty sensitive fields', () => {
    const fixture = {
      key: {
        remoteJid: 'synthetic-group-1-1700000000@g.us',
        id: 'synthetic-message-1',
        participant: 'synthetic-participant-1@lid',
      },
      pushName: 'Synthetic User',
      messageTimestamp: '1700000000',
      message: {
        extendedTextMessage: {
          text: '',
          contextInfo: {
            mentionedJid: ['synthetic-participant-1@lid'],
            participant: 'synthetic-user-1@s.whatsapp.net',
            quotedMessage: { conversation: '' },
          },
        },
        imageMessage: {
          url: '',
          directPath: '',
          mediaKey: '',
          fileSha256: '',
          fileLength: '1234567',
          caption: '',
          jpegThumbnail: '',
        },
        messageContextInfo: {
          messageSecret: '',
          deviceListMetadata: {
            senderKeyHash: '',
            senderTimestamp: '',
            recipientKeyHash: '',
            recipientTimestamp: '',
          },
        },
        protocolMessage: {
          key: {
            remoteJid: 'synthetic-user-1@s.whatsapp.net',
            id: 'synthetic-protocol-message-1',
          },
        },
      },
      mediaData: { localPath: '' },
    };

    expect(validateWhatsAppFixture(fixture)).toEqual([]);
  });

  test('sanitizes deterministically without mutating the source fixture', () => {
    const fixture = {
      key: {
        remoteJid: '628123456789@s.whatsapp.net',
        id: 'REAL_MESSAGE_ID',
        participant: '265841933336713@lid',
      },
      pushName: 'Real Person',
      phoneNumber: '+62 812-3456-7890',
      messageTimestamp: 1_700_000_000,
      message: {
        extendedTextMessage: {
          text: 'private reply',
          contextInfo: {
            mentionedJid: ['628123456789@s.whatsapp.net'],
            participant: '628123456789@s.whatsapp.net',
            quotedMessage: { conversation: 'private quoted body' },
          },
        },
        imageMessage: {
          url: 'https://example.invalid/signed-media',
          directPath: '/signed/media/path',
          mediaKey: 'private-media-key',
          fileSha256: 'private-hash',
          fileLength: 4096,
          caption: 'private caption',
          jpegThumbnail: 'private-thumbnail',
        },
        locationMessage: {
          degreesLatitude: -6.4898167,
          degreesLongitude: 106.8442796,
        },
        contactMessage: {
          displayName: 'Real Contact',
          vcard: 'BEGIN:VCARD\nFN:Real Contact\nEND:VCARD',
        },
        messageContextInfo: { messageSecret: 'private-secret' },
      },
    };

    const first = sanitizeWhatsAppFixture(fixture);
    const second = sanitizeWhatsAppFixture(fixture);

    expect(first).toEqual(second);
    expect(validateWhatsAppFixture(first)).toEqual([]);
    expect(fixture.key.remoteJid).toBe('628123456789@s.whatsapp.net');
    expect(first.key.remoteJid).toBe('synthetic-user-1@s.whatsapp.net');
    expect(first.key.id).toBe('synthetic-id-2');
    expect(first.key.participant).toBe('synthetic-participant-3@lid');
    expect(first.pushName).toBe('Synthetic User');
    expect(first.phoneNumber).toBe('');
    expect(first.message.extendedTextMessage.text).toBe('');
    expect(first.message.extendedTextMessage.contextInfo.quotedMessage.conversation).toBe('');
    expect(first.message.imageMessage.url).toBe('');
    expect(first.message.imageMessage.directPath).toBe('');
    expect(first.message.imageMessage.mediaKey).toBe('');
    expect(first.message.imageMessage.fileSha256).toBe('');
    expect(first.message.imageMessage.fileLength).toBe(4096);
    expect(first.message.imageMessage.jpegThumbnail).toBe('');
    expect(Object.keys(first.message.locationMessage)).toEqual([]);
    expect(first.message.contactMessage.displayName).toMatch(/^Synthetic Contact \d+$/);
    expect(first.message.contactMessage.vcard).toBe('');
    expect(first.message.messageContextInfo.messageSecret).toBe('');
  });

  test('rejects malformed JSON and non-object roots', () => {
    expect(validateWhatsAppFixtureJson('{').map(({ rule }) => rule)).toContain('structure');
    expect(validateWhatsAppFixtureJson('[]').map(({ rule }) => rule)).toContain('structure');
    expect(rulesFor([])).toContain('structure');
  });
});
