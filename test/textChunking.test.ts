import { describe, expect, test } from 'bun:test';
import { chunkTextSmart, chunkTextDiscord, chunkTextTelegram, chunkTextFixed } from '../src/utils/textChunking';

describe('chunkTextSmart', () => {
  test('empty input returns one empty chunk', () => {
    expect(chunkTextSmart('')).toEqual(['']);
    expect(chunkTextDiscord('')).toEqual(['']);
  });

  test('rejects a non-positive limit', () => {
    expect(() => chunkTextSmart('x', { limit: 0 })).toThrow('positive integer');
    expect(() => chunkTextSmart('x', { limit: 1.5 })).toThrow('positive integer');
  });

  test('fixed mode hard-splits and stays lossless', () => {
    const text = 'abcdefghij';
    const chunks = chunkTextFixed(text, 4);
    expect(chunks).toEqual(['abcd', 'efgh', 'ij']);
    expect(chunks.join('')).toBe(text);
  });

  test('boundary mode breaks anywhere in the trailing half', () => {
    // 10 chars, limit 8: the window is [4, 8). A newline at offset 5 must be
    // accepted. The previous implementation re-applied a half-window filter
    // inside the window, so only a break at offset >= 6 was allowed.
    const chunks = chunkTextSmart('abcd\nefghij', { mode: 'boundary', limit: 8 });
    expect(chunks[0]).toBe('abcd\n');
    expect(chunks.join('')).toBe('abcd\nefghij');
  });

  test('boundary mode keeps a paragraph break intact', () => {
    const text = 'aaaa\n\nbbbbbbbb';
    const chunks = chunkTextSmart(text, { mode: 'boundary', limit: 8 });
    expect(chunks[0]).toBe('aaaa\n\n');
    expect(chunks.join('')).toBe(text);
  });

  test('prefers a paragraph break over a later space', () => {
    // Both breaks fall inside the trailing half ([10, 20)), so the paragraph
    // break wins even though the space comes later.
    const text = `${'a'.repeat(12)}\n\nb c${'d'.repeat(10)}`;
    const chunks = chunkTextSmart(text, { mode: 'boundary', limit: 20 });
    expect(chunks[0]).toBe(`${'a'.repeat(12)}\n\n`);
    expect(chunks.join('')).toBe(text);
  });

  test('falls back to a hard split when no break exists in the window', () => {
    const text = 'a'.repeat(30);
    const chunks = chunkTextSmart(text, { mode: 'boundary', limit: 10 });
    expect(chunks).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(10)]);
  });

  test('never emits an empty chunk', () => {
    const text = 'word '.repeat(50);
    for (const chunk of chunkTextDiscord(text, 20)) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });
});

describe('chunkTextTelegram', () => {
  test('returns no chunks for empty input', () => {
    expect(chunkTextTelegram('')).toEqual([]);
  });

  test('trims trailing whitespace on each chunk', () => {
    const chunks = chunkTextTelegram('hello world \n\nnext', 12);
    for (const chunk of chunks) expect(chunk).toBe(chunk.trimEnd());
  });
});
