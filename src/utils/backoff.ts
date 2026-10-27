/**
 * @file src/utils/backoff.ts
 * @description Shared exponential backoff with jitter-free deterministic delays.
 *
 * Consolidates the backoff formula that was duplicated across
 * InboxService.fail, OutboxService.fail, and Scheduler (two call sites).
 * All three used `Math.min(max, base * 2 ** (attempt - 1))` with different
 * base values and different exponent caps. This is the single implementation.
 */

/**
 * Compute the retry delay for attempt number `attention` (1-based).
 *
 * @param attempt     1-based attempt number (1 = first retry).
 * @param baseMs      Base delay in milliseconds (e.g., 5_000 for 5s).
 * @param maxMs       Ceiling for the delay (default: 1 hour).
 * @param maxExponent Optional cap on the exponent (e.g., 7 limits growth).
 * @returns           Delay in milliseconds, never exceeding maxMs.
 */
export function exponentialBackoff(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; maxExponent?: number } = {},
): number {
  const { baseMs = 5_000, maxMs = 60 * 60_000, maxExponent } = options;
  const exponent = maxExponent !== undefined ? Math.min(attempt - 1, maxExponent) : Math.max(0, attempt - 1);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}
