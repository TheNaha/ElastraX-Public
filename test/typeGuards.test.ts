import { describe, expect, test } from 'bun:test';
import { isPlainObject } from '../src/utils/typeGuards';
import { stripBlobs, sanitizeRawMessage } from '../src/utils/rawMessage';

describe('isPlainObject', () => {
  test('accepts object literals and null-prototype objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  test('rejects arrays, null and primitives', () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject('string')).toBe(false);
    expect(isPlainObject(42)).toBe(false);
  });

  test('rejects non-plain objects such as Date and Buffer', () => {
    // A Buffer used to count as plain, so stripBlobs turned it into an
    // index-keyed object rather than leaving it intact.
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(Buffer.from([1, 2, 3]))).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(new (class Sample { value = 1; })())).toBe(false);
  });
});

describe('stripBlobs with a Buffer', () => {
  test('leaves a binary value untouched instead of exploding it into an object', () => {
    const raw = { message: { imageMessage: { mediaKey: Buffer.from([9, 9]), preview: Buffer.from([1, 2]) } } };
    const stripped = stripBlobs(raw) as { message: { imageMessage: Record<string, unknown> } };
    // A known blob key is removed entirely.
    expect(stripped.message.imageMessage.mediaKey).toBeUndefined();
    // An unknown binary field keeps its Buffer identity, not `{ '0': 1, '1': 2 }`.
    expect(Buffer.isBuffer(stripped.message.imageMessage.preview)).toBe(true);
  });

  test('sanitizeRawMessage serialises a plain raw message', () => {
    expect(sanitizeRawMessage({ key: { id: '1' }, message: { conversation: 'hi' } }))
      .toBe('{"key":{"id":"1"},"message":{"conversation":"hi"}}');
    expect(sanitizeRawMessage('not-an-object')).toBe('{}');
  });
});
