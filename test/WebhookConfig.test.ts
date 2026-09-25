import { describe, expect, test } from 'bun:test';
import { parseWebhookConfig } from '../src/webhooks/config';

const SECRET = 'configuration-secret-0123456789abcdef';

describe('parseWebhookConfig', () => {
  test('uses private bounded defaults', () => {
    const config = parseWebhookConfig({ WEBHOOK_SECRET: SECRET }, Date.parse('2026-09-25T00:00:00Z'));
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3500);
    expect(config.maxBodyBytes).toBe(262_144);
    expect(config.maxDestinations).toBe(25);
    expect(config.rateLimitMax).toBe(60);
    expect(config.replayMaxEntries).toBe(10_000);
    expect(config.bodySecretCompatibility.enabled).toBe(false);
  });

  test('requires an explicit container gate for an all-interface bind', () => {
    expect(() => parseWebhookConfig({ WEBHOOK_HOST: '0.0.0.0' })).toThrow('WEBHOOK_CONTAINER_MODE');
    expect(parseWebhookConfig({
      WEBHOOK_HOST: '0.0.0.0',
      WEBHOOK_CONTAINER_MODE: 'true',
    }).host).toBe('0.0.0.0');
  });

  test('rejects malformed booleans, integers, hosts, and weak secrets', () => {
    expect(() => parseWebhookConfig({ WEBHOOK_ENABLED: 'yes' })).toThrow('WEBHOOK_ENABLED');
    expect(() => parseWebhookConfig({ WEBHOOK_PORT: '3500.5' })).toThrow('WEBHOOK_PORT');
    expect(() => parseWebhookConfig({ WEBHOOK_MAX_BODY_BYTES: '99' })).toThrow('WEBHOOK_MAX_BODY_BYTES');
    expect(() => parseWebhookConfig({ WEBHOOK_HOST: '192.0.2.1' })).toThrow('WEBHOOK_HOST');
    expect(() => parseWebhookConfig({ WEBHOOK_SECRET: 'short' })).toThrow('WEBHOOK_SECRET');
    expect(() => parseWebhookConfig({ METRICS_AUTH_TOKEN: ` ${SECRET}` })).toThrow('METRICS_AUTH_TOKEN');
  });

  test('requires enabled compatibility to have a future absolute deadline', () => {
    const now = Date.parse('2026-09-25T00:00:00Z');
    expect(() => parseWebhookConfig({
      WEBHOOK_BODY_SECRET_COMPAT_ENABLED: 'true',
    }, now)).toThrow('WEBHOOK_BODY_SECRET_COMPAT_UNTIL');
    expect(() => parseWebhookConfig({
      WEBHOOK_QUERY_SECRET_COMPAT_ENABLED: 'true',
      WEBHOOK_QUERY_SECRET_COMPAT_UNTIL: '2026-09-26T00:00:00',
    }, now)).toThrow('absolute RFC3339');
    expect(() => parseWebhookConfig({
      WEBHOOK_QUERY_SECRET_COMPAT_ENABLED: 'true',
      WEBHOOK_QUERY_SECRET_COMPAT_UNTIL: '2026-02-30T00:00:00Z',
    }, now)).toThrow('absolute RFC3339');
    expect(() => parseWebhookConfig({
      WEBHOOK_BODY_SECRET_COMPAT_ENABLED: 'true',
      WEBHOOK_BODY_SECRET_COMPAT_UNTIL: '2026-09-24T00:00:00Z',
    }, now)).toThrow('future');

    const config = parseWebhookConfig({
      WEBHOOK_QUERY_SECRET_COMPAT_ENABLED: 'true',
      WEBHOOK_QUERY_SECRET_COMPAT_UNTIL: '2026-09-26T00:00:00+02:00',
    }, now);
    expect(config.querySecretCompatibility).toEqual({
      enabled: true,
      expiresAt: Date.parse('2026-09-25T22:00:00Z'),
    });
  });
});
