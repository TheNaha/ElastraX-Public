/**
 * @file test/similarity.test.ts
 * @description Unit tests for Levenshtein distance utility.
 */
import { describe, expect, test } from 'bun:test';
import { levenshtein } from '../src/utils/similarity';

describe('Levenshtein Similarity', () => {
  test('should return 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
    expect(levenshtein('', '')).toBe(0);
  });

  test('should return correct distance for simple edits', () => {
    // 1 substitution
    expect(levenshtein('hello', 'hallo')).toBe(1);
    // 1 deletion
    expect(levenshtein('status', 'statu')).toBe(1);
    // 1 insertion
    expect(levenshtein('ping', 'pings')).toBe(1);
  });

  test('should handle completely different strings', () => {
    // "abc" -> "def" = 3 substitutions
    expect(levenshtein('abc', 'def')).toBe(3);
  });

  test('should return length of non-empty string when comparing with empty string', () => {
    expect(levenshtein('hello', '')).toBe(5);
    expect(levenshtein('', 'world')).toBe(5);
  });

  test('should handle case sensitivity correctly (Levenshtein is case-sensitive)', () => {
    expect(levenshtein('Status', 'status')).toBe(1);
  });
});
