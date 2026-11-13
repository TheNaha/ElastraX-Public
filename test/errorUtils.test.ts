import { expect, test, describe } from 'bun:test';
import {
  stripControlChars,
  sanitizeErrorMessage,
  safeErrorMessage,
  toError,
  getErrorMessage,
} from '../src/utils/errorUtils';

describe('stripControlChars', () => {
  test('leaves printable text unchanged', () => {
    expect(stripControlChars('hello world')).toBe('hello world');
  });

  test('replaces control characters (code < 32) with spaces', () => {
    expect(stripControlChars('a\u0001b\u001fc')).toBe('a b c');
  });

  test('replaces DEL (code 127) with a space', () => {
    expect(stripControlChars('a\u007fc')).toBe('a c');
  });

  test('replaces newlines, tabs, and carriage returns', () => {
    expect(stripControlChars('a\nb\tc\rd')).toBe('a b c d');
  });

  test('replaces the ESC control character in ANSI sequences', () => {
    expect(stripControlChars('\u001b[31mred\u001b[0m')).toBe(' [31mred [0m');
  });

  test('uses a custom replacement character', () => {
    expect(stripControlChars('a\u0001b', '_')).toBe('a_b');
  });

  test('returns empty string for empty input', () => {
    expect(stripControlChars('')).toBe('');
  });
});

describe('sanitizeErrorMessage', () => {
  test('replaces control characters with spaces', () => {
    expect(sanitizeErrorMessage('err\u0001msg')).toBe('err msg');
  });

  test('truncates to the default max length of 500', () => {
    const long = 'x'.repeat(1000);
    expect(sanitizeErrorMessage(long).length).toBe(500);
  });

  test('truncates to a custom max length', () => {
    expect(sanitizeErrorMessage('abcdef', 3)).toBe('abc');
  });

  test('returns the input unchanged when under the limit and free of control characters', () => {
    expect(sanitizeErrorMessage('short error')).toBe('short error');
  });

  test('handles empty input', () => {
    expect(sanitizeErrorMessage('')).toBe('');
  });
});

describe('safeErrorMessage', () => {
  test('returns the message from an Error instance', () => {
    expect(safeErrorMessage(new Error('boom'))).toBe('boom');
  });

  test('sanitizes control characters in an Error message', () => {
    expect(safeErrorMessage(new Error('err\u0001msg'))).toBe('err msg');
  });

  test('returns a plain string as-is', () => {
    expect(safeErrorMessage('plain string')).toBe('plain string');
  });

  test('stringifies an unknown non-Error value', () => {
    expect(safeErrorMessage({ code: 500 } as unknown)).toBe('[object Object]');
  });

  test('handles null and undefined gracefully', () => {
    expect(safeErrorMessage(null)).toBe('null');
    expect(safeErrorMessage(undefined)).toBe('undefined');
  });

  test('respects a custom max length', () => {
    expect(safeErrorMessage(new Error('this is a long message'), 5)).toBe('this ');
  });
});

describe('toError', () => {
  test('returns an Error instance unchanged', () => {
    const original = new Error('original');
    expect(toError(original)).toBe(original);
  });

  test('wraps a string in an Error', () => {
    const err = toError('failure');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('failure');
  });

  test('wraps an unknown value in an Error', () => {
    const err = toError(42 as unknown);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('42');
  });
});

describe('getErrorMessage', () => {
  test('returns the message from an Error with a non-empty message', () => {
    expect(getErrorMessage(new Error('real error'))).toBe('real error');
  });

  test('falls back when an Error has an empty message', () => {
    expect(getErrorMessage(new Error(''), 'fallback')).toBe('fallback');
  });

  test('returns a non-empty string as-is', () => {
    expect(getErrorMessage('just a string', 'fallback')).toBe('just a string');
  });

  test('falls back for an empty string', () => {
    expect(getErrorMessage('', 'fallback')).toBe('fallback');
  });

  test('falls back for unknown values', () => {
    expect(getErrorMessage(null, 'fallback')).toBe('fallback');
    expect(getErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(getErrorMessage({} as unknown, 'fallback')).toBe('fallback');
  });

  test('uses "Unknown error" as the default fallback', () => {
    expect(getErrorMessage(null)).toBe('Unknown error');
    expect(getErrorMessage(new Error(''))).toBe('Unknown error');
  });
});
