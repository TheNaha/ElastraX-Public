/**
 * @file src/utils/date.ts
 * @description Small, pure date helpers shared across utilities.
 *
 * Centralizes the UTC `YYYY-MM-DD` day key so every consumer produces the
 * same key for the same instant, in one place.
 */

/** UTC date key (`YYYY-MM-DD`) for `now`. */
export function dateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}
