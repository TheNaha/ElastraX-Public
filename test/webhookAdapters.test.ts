/**
 * Webhook rate limiting, replay dedupe and adapter field handling.
 *
 * These pin defects where the guard reading the code was protecting the opposite
 * of what its own comment promised, and where a numeric field was dropped by a
 * string-only reader.
 */
import { describe, test, expect } from 'bun:test';
import { WebhookRateLimiter, WebhookReplayCache, webhookRateLimitKeys } from '../src/webhooks/utils';
import { adaptJellyfin, buildWebhookMessage } from '../src/webhooks/adapters';

describe('webhookRateLimitKeys', () => {
  test('omits the ip key for a loopback peer', () => {
    // Behind the documented reverse proxy requestIP is always 127.0.0.1, so an
    // ip key would put every sender in one shared bucket.
    expect(webhookRateLimitKeys('jellyfin', 'ci', '127.0.0.1')).toEqual(['source:jellyfin:ci']);
    expect(webhookRateLimitKeys('jellyfin', 'ci', '::1')).toEqual(['source:jellyfin:ci']);
  });

  test('keeps the ip key for a real remote peer', () => {
    expect(webhookRateLimitKeys('github', 'ci', '203.0.113.7')).toEqual(['source:github:ci', 'ip:203.0.113.7']);
  });

  test('two senders behind the same proxy are limited independently', () => {
    const limiter = new WebhookRateLimiter(2, 60_000, 10);
    const now = 1_000_000;
    const first = webhookRateLimitKeys('seerr', 'seerr-main', '127.0.0.1');
    const second = webhookRateLimitKeys('seerr', 'seerr-other', '127.0.0.1');
    expect(limiter.consume(first, now).allowed).toBe(true);
    expect(limiter.consume(first, now + 1).allowed).toBe(true);
    // The first source is now exhausted, but the second has its own bucket.
    expect(limiter.consume(first, now + 2).allowed).toBe(false);
    expect(limiter.consume(second, now + 3).allowed).toBe(true);
  });
});

describe('WebhookRateLimiter capacity', () => {
  test('a known key is never refused because its sibling key is unseen', () => {
    // maxSources 1: the known source already fills the map, and the request also
    // carries a fresh peer address. The old guard refused this request, locking a
    // legitimate sender out whenever its NAT/proxy address changed.
    const limiter = new WebhookRateLimiter(10, 60_000, 1);
    const now = 1_000_000;
    expect(limiter.consume(['source:github:ci'], now).allowed).toBe(true);
    expect(limiter.consume(['source:github:ci', 'ip:10.0.0.1'], now + 1).allowed).toBe(true);
    expect(limiter.size).toBe(1);
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

  test('a full cache evicts the oldest completed id instead of refusing every event', () => {
    // 24 h TTL and a small cap: the old code returned 'capacity' for every new
    // id until the TTL expired, i.e. a permanent intake outage once the cap was
    // reached. Eviction keeps the newest ids deduplicated and the intake open.
    const cache = new WebhookReplayCache(24 * 60 * 60_000, 2);
    const now = 1_000_000;
    expect(cache.reserve('github:a', now)).toBe('reserved');
    cache.complete('github:a', now);
    expect(cache.reserve('github:b', now + 1)).toBe('reserved');
    cache.complete('github:b', now + 1);

    expect(cache.reserve('github:c', now + 2)).toBe('reserved');
    cache.complete('github:c', now + 2);
    // The newest ids are still deduplicated.
    expect(cache.reserve('github:b', now + 3)).toBe('duplicate');
    expect(cache.reserve('github:c', now + 4)).toBe('duplicate');
  });

  test('reports capacity only when every slot is an in-flight request', () => {
    const cache = new WebhookReplayCache(60_000, 2);
    const now = 1_000_000;
    expect(cache.reserve('github:a', now)).toBe('reserved');
    expect(cache.reserve('github:b', now)).toBe('reserved');
    // Nothing completed, so there is no entry that could be evicted.
    expect(cache.reserve('github:c', now)).toBe('capacity');
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
