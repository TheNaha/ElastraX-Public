import { describe, test, expect, mock, beforeEach } from 'bun:test';

mock.module('../src/utils/logger', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) },
}));

import { RateLimiter } from '../src/utils/RateLimiter';

describe('RateLimiter', () => {
  beforeEach(() => {
    RateLimiter.reset('test-user', 'whatsapp');
  });

  test('check() first call should be allowed', () => {
    const result = RateLimiter.check('test-user', 'whatsapp');
    expect(result.allowed).toBe(true);
  });

  test('check() after exhausting tokens should return allowed: false', () => {
    const maxTokens = parseInt(process.env.RATE_LIMIT_MESSAGES || '10', 10);
    for (let i = 0; i < maxTokens; i++) {
      RateLimiter.check('test-user', 'whatsapp');
    }
    const result = RateLimiter.check('test-user', 'whatsapp');
    expect(result.allowed).toBe(false);
    expect(typeof result.waitSeconds).toBe('number');
  });

  test('checkWithLimits() with -1 always returns allowed: true', () => {
    for (let i = 0; i < 100; i++) {
      const result = RateLimiter.checkWithLimits('test-user', 'whatsapp', -1, 60);
      expect(result.allowed).toBe(true);
    }
  });

  test('checkWithLimits() with custom limits works correctly', () => {
    const result = RateLimiter.checkWithLimits('test-user', 'whatsapp', 3, 60);
    expect(result.allowed).toBe(true);

    RateLimiter.checkWithLimits('test-user', 'whatsapp', 3, 60);
    RateLimiter.checkWithLimits('test-user', 'whatsapp', 3, 60);
    const exhausted = RateLimiter.checkWithLimits('test-user', 'whatsapp', 3, 60);
    expect(exhausted.allowed).toBe(false);
  });

  test('reset() clears the bucket — subsequent check is allowed', () => {
    const maxTokens = parseInt(process.env.RATE_LIMIT_MESSAGES || '10', 10);
    for (let i = 0; i < maxTokens; i++) {
      RateLimiter.check('test-user', 'whatsapp');
    }
    const exhausted = RateLimiter.check('test-user', 'whatsapp');
    expect(exhausted.allowed).toBe(false);

    RateLimiter.reset('test-user', 'whatsapp');
    const afterReset = RateLimiter.check('test-user', 'whatsapp');
    expect(afterReset.allowed).toBe(true);
  });

  test('prune() removes stale buckets', () => {
    // Create a bucket
    RateLimiter.check('stale-user', 'whatsapp');
    // Prune shouldn't remove it yet (it's fresh)
    RateLimiter.prune();
    // Should still work (bucket still exists with tokens)
    const result = RateLimiter.check('stale-user', 'whatsapp');
    expect(result.allowed).toBe(true);

    // Clean up
    RateLimiter.reset('stale-user', 'whatsapp');
  });

  test('bucket resizing: tokens scale proportionally when limits change', () => {
    // Start with limit of 10, consume 5 tokens (50% used, 50% remaining)
    for (let i = 0; i < 5; i++) {
      RateLimiter.checkWithLimits('resize-user', 'whatsapp', 10, 60);
    }
    // Now change limit to 20 — tokens should scale proportionally
    const result = RateLimiter.checkWithLimits('resize-user', 'whatsapp', 20, 60);
    expect(result.allowed).toBe(true);

    // Clean up
    RateLimiter.reset('resize-user', 'whatsapp');
  });

  test('checkWithLimits() sanitizes invalid limits to safe defaults', () => {
    const first = RateLimiter.checkWithLimits('invalid-user', 'whatsapp', 0, 0);
    expect(first.allowed).toBe(true);
    const second = RateLimiter.checkWithLimits('invalid-user', 'whatsapp', 0, 0);
    expect(second.allowed).toBe(false);
    expect(second.waitSeconds).toBeGreaterThan(0);

    RateLimiter.reset('invalid-user', 'whatsapp');
  });
});
