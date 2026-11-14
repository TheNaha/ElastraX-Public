import { describe, expect, test } from 'bun:test';
import { stripPartialThinkTags, stripThinkTags } from '../src/utils/textUtils';

// Built from parts so the literal tags below cannot be reformatted or lost.
const OPEN = '<' + 'think>';
const CLOSE = '<' + '/think>';

describe('stripThinkTags', () => {
  test('removes a closed think block', () => {
    expect(stripThinkTags(`a\n${OPEN}hidden${CLOSE}b`)).toBe('a\nb');
  });

  test('keeps an unterminated block, because it is not yet a complete block', () => {
    expect(stripThinkTags(`a\n${OPEN}still thinking`)).toBe(`a\n${OPEN}still thinking`);
  });
});

describe('stripPartialThinkTags', () => {
  test('removes an unterminated block that is still being streamed', () => {
    expect(stripPartialThinkTags(`answer so far\n${OPEN}here is my reasoning`)).toBe('answer so far');
  });

  test('removes complete and trailing open blocks together', () => {
    expect(stripPartialThinkTags(`a\n${OPEN}closed${CLOSE}b\n${OPEN}still thinking`)).toBe('a\nb');
  });

  test('is empty while only reasoning has arrived', () => {
    expect(stripPartialThinkTags(`\n${OPEN}only reasoning so far`)).toBe('');
  });

  test('leaves ordinary text untouched', () => {
    expect(stripPartialThinkTags('  plain answer  ')).toBe('plain answer');
  });
});
