import { describe, expect, test } from 'bun:test';
import { chunkTextSmart, chunkTextDiscord, chunkTextTelegram, chunkTextFixed, splitTextAtUtf16Limit } from '../src/utils/textChunking';

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

  test('keeps a paragraph break whole even when it straddles the hard limit', () => {
    const text = 'aaa\n\nbbb';
    const chunks = chunkTextSmart(text, { mode: 'boundary', limit: 4 });
    expect(chunks.join('')).toBe(text);
    // No chunk may end with the first half of the pair while the next starts with
    // the second half.
    for (const chunk of chunks) expect(chunk.startsWith('\n\n') || !chunk.startsWith('\n')).toBe(true);
    expect(chunks.some(chunk => chunk.includes('\n\n'))).toBe(true);
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

describe('chunkTextSmart — code points vs UTF-16 offsets', () => {
  /**
   * The window is indexed as an array of code points, but `String.lastIndexOf`
   * answers in UTF-16 units. An emoji before the delimiter made the two scales
   * disagree by one per astral character, so the split landed past the break it
   * had found and cut a word in half.
   */
  test('breaks at the delimiter even when an astral character precedes it', () => {
    const text = `${'😀'.repeat(30)} done\n${'x'.repeat(30)}`;
    const chunks = chunkTextSmart(text, { mode: 'boundary', limit: 40 });

    // Every chunk stays inside the limit and the first one ends at the newline,
    // not after it and not in the middle of "done".
    for (const chunk of chunks) expect(Array.from(chunk).length).toBeLessThanOrEqual(40);
    expect(chunks[0]!.endsWith('\n')).toBe(true);
    expect(chunks[0]!.trimEnd().endsWith('done')).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  test('stays lossless and within the limit for emoji-only text', () => {
    const text = '😀'.repeat(95);
    const chunks = chunkTextSmart(text, { mode: 'boundary', limit: 20 });
    for (const chunk of chunks) expect(Array.from(chunk).length).toBeLessThanOrEqual(20);
    expect(chunks.join('')).toBe(text);
  });

  test('utf16 measure keeps emoji chunks inside the provider limit', () => {
    // 3000 emoji are 6000 UTF-16 units: the Bot API would reject a single
    // 4096-code-point chunk as "message is too long".
    const text = '😀'.repeat(3000);
    const chunks = chunkTextSmart(text, { mode: 'fixed', limit: 4096, measure: 'utf16' });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      // No lone surrogate at either edge of the chunk.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(chunk)).toBe(false);
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
    }
    expect(chunks.join('')).toBe(text);
  });
});

describe('chunkTextTelegram — UTF-16 limit', () => {
  test('splits emoji text by UTF-16 units, not code points', () => {
    const text = '😀'.repeat(3000);
    const chunks = chunkTextTelegram(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096);
    expect(chunks.join('')).toBe(text);
  });

  test('ASCII text still chunks at 4096 characters', () => {
    expect(chunkTextTelegram('a'.repeat(4200))).toEqual(['a'.repeat(4096), 'a'.repeat(104)]);
  });
});

describe('splitTextAtUtf16Limit', () => {
  test('leaves short text untouched', () => {
    expect(splitTextAtUtf16Limit('hello', 4096)).toEqual({ head: 'hello', rest: '' });
  });

  test('never splits a surrogate pair', () => {
    const { head, rest } = splitTextAtUtf16Limit(`${'a'.repeat(4)}😀b`, 4);
    expect(head).toBe('aaaa');
    expect(rest).toBe('😀b');
    const splitInside = splitTextAtUtf16Limit(`${'a'.repeat(3)}😀b`, 4);
    expect(splitInside.head).toBe('aaa');
    expect(splitInside.rest).toBe('😀b');
    expect(splitInside.head.length + splitInside.rest.length).toBe(`${'a'.repeat(3)}😀b`.length);
  });

  test('rejects a non-positive limit', () => {
    expect(() => splitTextAtUtf16Limit('x', 0)).toThrow('positive integer');
  });
});
