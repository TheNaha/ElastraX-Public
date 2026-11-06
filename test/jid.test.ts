import { describe, expect, test } from 'bun:test';
import { jidBareId, jidUser } from '../src/utils/jid';

describe('jidBareId', () => {
  test('strips @server', () => {
    expect(jidBareId('628123@s.whatsapp.net')).toBe('628123');
  });
  test('strips :device suffix', () => {
    expect(jidBareId('628123:5@s.whatsapp.net')).toBe('628123');
  });
  test('strips both :device and @server', () => {
    expect(jidBareId('628123:5:7@s.whatsapp.net')).toBe('628123');
  });
  test('non-JID falls back to raw input (lenient)', () => {
    expect(jidBareId('plain-id')).toBe('plain-id');
  });
  test('empty string returns empty string', () => {
    expect(jidBareId('')).toBe('');
  });
  test('leading colon returns empty (before first :)', () => {
    expect(jidBareId(':5@s.whatsapp.net')).toBe('');
  });
});

describe('jidUser', () => {
  test('returns user part before @', () => {
    expect(jidUser('628123@s.whatsapp.net')).toBe('628123');
    expect(jidUser('628123:5@s.whatsapp.net')).toBe('628123:5');
  });
  test('returns undefined for empty or non-JID input', () => {
    expect(jidUser(undefined)).toBeUndefined();
    expect(jidUser('')).toBeUndefined();
    expect(jidUser('no-at-sign')).toBeUndefined();
    expect(jidUser('@s.whatsapp.net')).toBeUndefined();
  });
});
