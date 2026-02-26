/**
 * @file src/utils/RateLimiter.ts
 * @description Token-bucket rate limiter for per-user message throttling.
 *
 * Prevents a single user from flooding the LLM endpoint or tools.
 * Each user gets a bucket with a fixed capacity of tokens. Tokens are consumed
 * on each message and refill at a constant rate over time.
 *
 * Configuration via environment variables:
 *  - RATE_LIMIT_MESSAGES  : Max messages per window (default: 10)
 *  - RATE_LIMIT_WINDOW_SEC: Refill window in seconds (default: 60)
 *
 * Bot owners and admins bypass rate limiting entirely.
 *
 * Usage:
 * ```ts
 * const { allowed, waitSeconds } = RateLimiter.check(userId, platform);
 * if (!allowed) {
 *   await ctx.reply(t(ctx.language, 'agent.rate_limited', { seconds: String(waitSeconds) }));
 *   return;
 * }
 * ```
 */

import { logger } from './logger';

interface Bucket {
  tokens: number;
  lastRefill: number; // ms timestamp
}

export class RateLimiter {
  private static buckets = new Map<string, Bucket>();

  private static readonly MAX_TOKENS = parseInt(process.env.RATE_LIMIT_MESSAGES || '10', 10);
  private static readonly WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_SEC || '60', 10) * 1000;

  /**
   * Checks whether a user is within their rate limit.
   * Consumes one token if allowed.
   *
   * @param userId   Unique user identifier (JID / Discord ID).
   * @param platform Platform identifier for namespacing.
   * @returns        `{ allowed: true }` or `{ allowed: false, waitSeconds: number }`.
   */
  static check(userId: string, platform: string): { allowed: boolean; waitSeconds?: number } {
    const key = `${platform}:${userId}`;
    const now = Date.now();

    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.MAX_TOKENS - 1, lastRefill: now };
      this.buckets.set(key, bucket);
      return { allowed: true };
    }

    // Refill tokens proportionally based on elapsed time
    const elapsed = now - bucket.lastRefill;
    const refillAmount = (elapsed / this.WINDOW_MS) * this.MAX_TOKENS;
    bucket.tokens = Math.min(this.MAX_TOKENS, bucket.tokens + refillAmount);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    // Calculate wait time until one token refills
    const tokenRefillMs = this.WINDOW_MS / this.MAX_TOKENS;
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
   * Cleans up stale buckets that have not been touched for 2x the window duration.
   * Call periodically to prevent unbounded memory growth.
   */
  static prune(): void {
    const cutoff = Date.now() - this.WINDOW_MS * 2;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) {
        this.buckets.delete(key);
      }
    }
  }
}
