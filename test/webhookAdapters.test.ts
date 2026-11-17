/**
 * Webhook rate limiting, replay dedupe and adapter field handling.
 *
 * These pin defects where the guard reading the code was protecting the opposite
 * of what its own comment promised, and where a numeric field was dropped by a
 * string-only reader.
 */
import { describe, test, expect } from 'bun:test';
import { WebhookRateLimiter, WebhookReplayCache } from '../src/webhooks/utils';
import { buildWebhookMessage } from '../src/webhooks/adapters';
import { adaptJellyfin } from '../src/webhooks/adapters';

describe('WebhookRateLimiter capacity', () => {
  test('a known key is never refused because its sibling key is unseen', () => {
    // maxSources 2: one known source fills the map; the request also carries a
    // fresh peer address. Refusing here locked a legitimate sender out whenever
    // its NAT/proxy address changed while the table was at capacity.
    const limiter = new WebhookRateLimiter(10, 60_000, 2);
    const now = 1_000_000;
    expect(limiter.consume(['source:github:ci'], now).allowed).toBe(true);
    expect(limiter.consume(['source:github:ci', 'ip:10.0.0.1'], now + 1).allowed).toBe(true);
  });

  test('the bucket map does not grow past maxSources', () => {
    const limiter = new WebhookRateLimiter(10, 60_000, 3);
    const now = 1_000_000;
    limiter.consume(['source:a'], now);
    limiter.consume(['source:b'], now);
    limiter.consume(['source:c'], now);
    // Unknown keys beyond the cap are not stored: requests made only of them are
    // refused, and none of them can inflate the map.
    expect(limiter.consume(['source:d'], now).allowed).toBe(false);
    expect(limiter.consume(['source:e'], now).allowed).toBe(false);
    expect(limiter.size).toBe(3);
  });

  test('a request made only of unseen keys is refused once the map is full', () => {
    const limiter = new WebhookRateLimiter(10, 60_000, 1);
    const now = 1_000_000;
    expect(limiter.consume(['source:a'], now).allowed).toBe(true);
    const denied = limiter.consume(['source:b'], now + 1);
    expect(denied.allowed).toBe(false);
    // The retry hint must outlast the prune window (two windows), not one.
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(120);
  });

  test('a full bucket still throttles its own key', () => {
    const limiter = new WebhookRateLimiter(1, 60_000, 10);
    const now = 1_000_000;
    expect(limiter.consume(['source:a'], now).allowed).toBe(true);
    expect(limiter.consume(['source:a'], now + 1).allowed).toBe(false);
  });
});

describe('WebhookReplayCache', () => {
  test('a reservation that is still in flight is not reported as a completed duplicate', () => {
    const cache = new WebhookReplayCache(60_000, 10);
    const now = 1_000_000;
    expect(cache.reserve('github:1', now)).toBe('reserved');
    expect(cache.reserve('github:1', now + 1)).toBe('in_flight');
    cache.complete('github:1', now + 2);
    expect(cache.reserve('github:1', now + 3)).toBe('duplicate');
  });

  test('releasing an in-flight reservation makes the id retryable again', () => {
    const cache = new WebhookReplayCache(60_000, 10);
    const now = 1_000_000;
    expect(cache.reserve('github:2', now)).toBe('reserved');
    cache.release('github:2');
    expect(cache.reserve('github:2', now + 1)).toBe('reserved');
  });
});

describe('webhook adapters', () => {
  test('a Grafana payload is detected without the origin header', () => {
    const msg = buildWebhookMessage({}, {
      alerts: [{ status: 'firing', labels: { alertname: 'DiskFull' }, annotations: { summary: 'Disk 99%' } }],
    });
    expect(msg).toContain('DiskFull');
    expect(msg).toContain('Disk 99%');
    expect(msg).not.toContain('Webhook payload received');
  });

  test('Jellyfin numeric fields survive the adapter', () => {
    const text = adaptJellyfin({
      NotificationType: 'ItemAdded',
      Name: 'Episode One',
      SeriesName: 'Some Show',
      Year: 2026,
      SeasonNumber00: 1,
      EpisodeNumber00: 4,
      Overview: 'Pilot',
    });
    expect(text).toContain('(2026)');
    expect(text).toContain('S1E4');
  });
});
