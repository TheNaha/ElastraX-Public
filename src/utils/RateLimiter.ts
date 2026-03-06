/**
 * @file src/utils/RateLimiter.ts
 * @description Token-bucket rate limiter for per-user message throttling.
 *
 * Prevents a single user from flooding the LLM endpoint or tools.
 * Each user gets a bucket with a configurable capacity of tokens.  Tokens are
 * consumed on each message and refill at a constant rate over time.
 *
 * V7.11: Supports **per-role variable limits** via `checkWithLimits()`.
 * The legacy `check()` method still works using the global env defaults.
 *
 * Configuration via environment variables (global fallback):
 *  - RATE_LIMIT_MESSAGES  : Max messages per window (default: 10)
 *  - RATE_LIMIT_WINDOW_SEC: Refill window in seconds (default: 60)
 *
 * Per-role overrides are controlled by `PrivilegeService` and passed to
 * `checkWithLimits()` at call-time.
 */

import { logger } from './logger';

interface Bucket {
  tokens: number;
  lastRefill: number; // ms timestamp
  maxTokens: number;  // bucket capacity (can vary per user/role)
  windowMs: number;   // refill window ms
}

export class RateLimiter {
  private static buckets = new Map<string, Bucket>();

  private static readonly DEFAULT_MAX_TOKENS = parseInt(process.env.RATE_LIMIT_MESSAGES || '10', 10);
  private static readonly DEFAULT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_SEC || '60', 10) * 1000;

  /**
   * Checks whether a user is within their rate limit using global env defaults.
   * Consumes one token if allowed.
   */
  static check(userId: string, platform: string): { allowed: boolean; waitSeconds?: number } {
    return this.checkWithLimits(userId, platform, this.DEFAULT_MAX_TOKENS, this.DEFAULT_WINDOW_MS / 1000);
  }

  /**
   * Checks whether a user is within their rate limit using **custom** limits.
   * This allows per-role variable rate limiting.
   *
   * @param userId          Unique user identifier (JID / Discord ID).
   * @param platform        Platform identifier for namespacing.
   * @param maxMessages     Max messages per window.  -1 = unlimited (always allowed).
   * @param windowSec       Window duration in seconds.
   * @returns               `{ allowed: true }` or `{ allowed: false, waitSeconds: number }`.
   */
  static checkWithLimits(
    userId: string,
    platform: string,
    maxMessages: number,
    windowSec: number,
  ): { allowed: boolean; waitSeconds?: number } {
    // -1 means unlimited — always allow
    if (maxMessages === -1) return { allowed: true };
    const safeMaxMessages = Number.isFinite(maxMessages) ? Math.max(1, Math.floor(maxMessages)) : 1;
    const safeWindowSec = Number.isFinite(windowSec) ? Math.max(1, Math.floor(windowSec)) : 60;

    const key = `${platform}:${userId}`;
    const now = Date.now();
    const windowMs = safeWindowSec * 1000;

    let bucket = this.buckets.get(key);

    // If the bucket exists but its limits changed (e.g., user gained a role), re-size it
    if (bucket && (bucket.maxTokens !== safeMaxMessages || bucket.windowMs !== windowMs)) {
      // Scale tokens proportionally to new capacity
      const ratio = bucket.tokens / bucket.maxTokens;
      bucket.maxTokens = safeMaxMessages;
      bucket.windowMs = windowMs;
      bucket.tokens = Math.min(safeMaxMessages, Math.floor(ratio * safeMaxMessages));
    }

    if (!bucket) {
      bucket = { tokens: safeMaxMessages - 1, lastRefill: now, maxTokens: safeMaxMessages, windowMs };
      this.buckets.set(key, bucket);
      return { allowed: true };
    }

    // Refill tokens proportionally based on elapsed time
    const elapsed = now - bucket.lastRefill;
    const refillAmount = (elapsed / bucket.windowMs) * bucket.maxTokens;
    bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + refillAmount);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    // Calculate wait time until one token refills
    const tokenRefillMs = bucket.windowMs / bucket.maxTokens;
    const waitSeconds = Math.ceil(tokenRefillMs / 1000);

    logger.debug({ userId, platform, tokens: bucket.tokens }, '[RateLimiter] Rate limit hit');

    return { allowed: false, waitSeconds };
  }

  /**
   * Resets the bucket for a specific user (e.g., after an admin command).
   */
  static reset(userId: string, platform: string): void {
    this.buckets.delete(`${platform}:${userId}`);
  }

  /**
   * Cleans up stale buckets that have not been touched for 2x the default window duration.
   * Call periodically to prevent unbounded memory growth.
   */
  static prune(): void {
    const cutoff = Date.now() - this.DEFAULT_WINDOW_MS * 2;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) {
        this.buckets.delete(key);
      }
    }
  }
}
