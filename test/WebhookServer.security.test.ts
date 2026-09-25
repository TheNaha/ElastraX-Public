import { describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'crypto';
import { withEnvironment } from './helpers/env';

const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};

mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

import { verifyGitHubSignature } from '../src/webhooks/utils';
import { WebhookServer } from '../src/webhookServer';
import { APP_RELEASE_TAG, APP_VERSION } from '../src/config/version';
import type { WebhookDeliveryJob } from '../src/webhooks/types';

const SECRET = 'test-webhook-secret-0123456789abcdef';
const METRICS_SECRET = 'test-metrics-secret-0123456789abcdef';
const BASE_ENV = {
  WEBHOOK_ENABLED: 'true',
  WEBHOOK_HOST: '127.0.0.1',
  WEBHOOK_PORT: '0',
  WEBHOOK_SECRET: SECRET,
  WEBHOOK_BODY_SECRET_COMPAT_ENABLED: undefined,
  WEBHOOK_BODY_SECRET_COMPAT_UNTIL: undefined,
  WEBHOOK_QUERY_SECRET_COMPAT_ENABLED: undefined,
  WEBHOOK_QUERY_SECRET_COMPAT_UNTIL: undefined,
  WEBHOOK_MAX_DESTINATIONS: undefined,
  WEBHOOK_MAX_BODY_BYTES: undefined,
  WEBHOOK_RATE_LIMIT_MAX: undefined,
  SEERR_WEBHOOK_SECRET: undefined,
  JELLYFIN_WEBHOOK_SECRET: undefined,
  METRICS_AUTH_TOKEN: undefined,
};

function portOf(server: WebhookServer): number {
  const port = (server as unknown as { server?: { port?: number } }).server?.port;
  if (typeof port !== 'number') throw new Error('Webhook server did not start');
  return port;
}

async function withServer(
  overrides: Record<string, string | undefined>,
  callback: (server: WebhookServer, baseUrl: string) => Promise<void>,
  register?: (server: WebhookServer) => void,
): Promise<void> {
  await withEnvironment({ ...BASE_ENV, ...overrides }, async () => {
    const server = new WebhookServer();
    register?.(server);
    server.start();
    try {
      await callback(server, `http://127.0.0.1:${portOf(server)}`);
    } finally {
      server.stop();
    }
  });
}

describe('WebhookServer security and HTTP contract', () => {
  test('verifies only SHA-256 GitHub signatures', () => {
    const payload = JSON.stringify({ action: 'push', repository: { full_name: 'test/repo' } });
    const signature = `sha256=${createHmac('sha256', SECRET).update(payload).digest('hex')}`;
    expect(verifyGitHubSignature(payload, SECRET, signature)).toBe(true);
    expect(verifyGitHubSignature(payload, SECRET, null)).toBe(false);
    expect(verifyGitHubSignature(payload, SECRET, signature.replace('sha256=', 'sha1='))).toBe(false);
    expect(verifyGitHubSignature(`${payload}x`, SECRET, signature)).toBe(false);
  });

  test('rejects a non-string JSON secret without echoing it', async () => {
    await withServer({}, async (_server, baseUrl) => {
      const response = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: '123456', text: 'hello', secret: { nested: true } }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Invalid or missing secret' });
    });
  });

  test('enforces exact routes, methods, JSON content type, and minimal health responses', async () => {
    await withServer({}, async (_server, baseUrl) => {
      const method = await Bun.fetch(`${baseUrl}/webhook`);
      expect(method.status).toBe(405);
      expect(method.headers.get('allow')).toBe('POST');

      const route = await Bun.fetch(`${baseUrl}/webhook/unknown`, { method: 'POST' });
      expect(route.status).toBe(404);

      const contentType = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-Webhook-Secret': SECRET },
        body: 'hello',
      });
      expect(contentType.status).toBe(415);
      expect((await Bun.fetch(`${baseUrl}/metrics`)).status).toBe(404);

      for (const path of ['/health', '/live']) {
        const response = await Bun.fetch(`${baseUrl}${path}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: 'ok', version: APP_VERSION, releaseTag: APP_RELEASE_TAG });
      }

      const ready = await Bun.fetch(`${baseUrl}/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: 'ready', version: APP_VERSION, releaseTag: APP_RELEASE_TAG });
    });
  });

  test('exposes metrics only with the dedicated token', async () => {
    await withServer({ METRICS_AUTH_TOKEN: METRICS_SECRET }, async (_server, baseUrl) => {
      expect((await Bun.fetch(`${baseUrl}/metrics`)).status).toBe(401);
      expect((await Bun.fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: `Bearer ${METRICS_SECRET}x` },
      })).status).toBe(401);

      const response = await Bun.fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: `Bearer ${METRICS_SECRET}` },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('elastrax_uptime_seconds');
    });
  });

  test('reports not ready without exposing dependency details', async () => {
    await withServer({}, async (server, baseUrl) => {
      const unregister = server.registerReadinessCheck(() => false);
      try {
        const response = await Bun.fetch(`${baseUrl}/ready`);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ status: 'not_ready', version: APP_VERSION, releaseTag: APP_RELEASE_TAG });
      } finally {
        unregister();
      }
    });
  });

  test('fails closed when the generic secret is missing', async () => {
    await withServer({ WEBHOOK_SECRET: undefined }, async (_server, baseUrl) => {
      const response = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: '123456', text: 'hello' }),
      });
      expect(response.status).toBe(503);
    });
  });

  test('validates destinations and source bounds', async () => {
    await withServer({ WEBHOOK_MAX_DESTINATIONS: '2' }, async (_server, baseUrl) => {
      const missing = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': SECRET },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(missing.status).toBe(400);

      const tooMany = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': SECRET },
        body: JSON.stringify({ room_ids: ['100', '200', '300'], text: 'hello' }),
      });
      expect(tooMany.status).toBe(400);

      const badSource = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': SECRET },
        body: JSON.stringify({ room_id: '100', text: 'hello', source: 'not valid' }),
      });
      expect(badSource.status).toBe(400);
    });
  });

  test('disables body and query secret compatibility by default', async () => {
    await withServer({}, async (_server, baseUrl) => {
      const body = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: '100', text: 'hello', secret: SECRET }),
      });
      expect(body.status).toBe(401);

      const query = await Bun.fetch(`${baseUrl}/webhook?room_id=100&secret=${SECRET}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(query.status).toBe(401);
    });
  });

  test('accepts body and query secrets only inside an enabled future window', async () => {
    const send = mock(async () => {});
    const future = new Date(Date.now() + 60_000).toISOString();
    await withServer({
      WEBHOOK_BODY_SECRET_COMPAT_ENABLED: 'true',
      WEBHOOK_BODY_SECRET_COMPAT_UNTIL: future,
      WEBHOOK_QUERY_SECRET_COMPAT_ENABLED: 'true',
      WEBHOOK_QUERY_SECRET_COMPAT_UNTIL: future,
    }, async (_server, baseUrl) => {
      const body = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: '100', text: 'body', secret: SECRET }),
      });
      expect(body.status).toBe(200);

      const query = await Bun.fetch(`${baseUrl}/webhook?room_id=200&secret=${SECRET}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'query' }),
      });
      expect(query.status).toBe(200);
    }, server => server.registerSender('discord', send));
  });

  test('never forwards authentication fields to chat', async () => {
    const send = mock(async (_roomId: string, text: string) => {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('nested-secret');
    });
    const future = new Date(Date.now() + 60_000).toISOString();
    await withServer({
      WEBHOOK_BODY_SECRET_COMPAT_ENABLED: 'true',
      WEBHOOK_BODY_SECRET_COMPAT_UNTIL: future,
    }, async (_server, baseUrl) => {
      const response = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_id: '100',
          secret: SECRET,
          message: `do not forward ${SECRET}`,
          nested: { api_key: 'nested-secret', value: 1 },
        }),
      });
      expect(response.status).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
    }, server => server.registerSender('discord', send));
  });

  test('preserves partial synchronous delivery semantics', async () => {
    const send = mock(async (roomId: string) => {
      if (roomId === '200') throw new Error('blocked');
    });
    await withServer({}, async (_server, baseUrl) => {
      const response = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': SECRET },
        body: JSON.stringify({ room_ids: ['100', '200'], text: 'hello' }),
      });
      expect(response.status).toBe(207);
      expect(await response.json()).toEqual({
        ok: false,
        delivered: 1,
        failed: [{ roomId: '200', error: 'Delivery failed' }],
      });
    }, server => server.registerSender('discord', send));
  });

  test('deduplicates explicit replay IDs during the TTL', async () => {
    const send = mock(async () => {});
    await withServer({}, async (_server, baseUrl) => {
      const request = () => Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': SECRET,
          'X-Webhook-Id': 'request-123',
        },
        body: JSON.stringify({ room_id: '100', text: 'hello' }),
      });
      expect((await request()).status).toBe(200);
      const duplicate = await request();
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toEqual({ ok: true, duplicate: true, delivered: 0 });
      expect(send).toHaveBeenCalledTimes(1);
    }, server => server.registerSender('discord', send));
  });

  test('returns 202 only after the enqueuer accepts a durable job', async () => {
    let queued: WebhookDeliveryJob | null = null;
    const enqueuer = mock(async (job: WebhookDeliveryJob) => {
      queued = job;
      return { accepted: true, deliveryId: 'delivery-123', acceptedAt: '2026-09-25T00:00:00.000Z' };
    });
    await withServer({}, async (server, baseUrl) => {
      const response = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': SECRET,
          'X-Webhook-Id': 'event-123',
        },
        body: JSON.stringify({ room_id: '100', title: 'Alert', message: 'hello', secret: SECRET }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        ok: true,
        status: 'queued',
        duplicate: false,
        deliveryId: 'delivery-123',
        acceptedAt: '2026-09-25T00:00:00.000Z',
      });
      expect(enqueuer).toHaveBeenCalledTimes(1);
      expect(queued!.eventId).toBe('event-123');
      expect(queued!.text).not.toContain(SECRET);
    }, server => server.registerEnqueuer(enqueuer));
  });

  test('does not acknowledge when an enqueuer rejects a job', async () => {
    const enqueuer = mock(async () => ({ accepted: false, deliveryId: 'rejected' }));
    await withServer({}, async (server, baseUrl) => {
      const response = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': SECRET },
        body: JSON.stringify({ room_id: '100', text: 'hello' }),
      });
      expect(response.status).toBe(503);
      expect(enqueuer).toHaveBeenCalledTimes(1);
    }, server => server.registerEnqueuer(enqueuer));
  });

  test('aborts an enqueuer that exceeds the durable acceptance deadline', async () => {
    let enqueueSignal: AbortSignal | null = null;
    const enqueuer = mock((_job, signal: AbortSignal) => new Promise<never>((_, reject) => {
      enqueueSignal = signal;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    await withServer({ WEBHOOK_ENQUEUE_TIMEOUT_MS: '100' }, async (server, baseUrl) => {
      const response = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': SECRET },
        body: JSON.stringify({ room_id: '100', text: 'hello' }),
      });
      expect(response.status).toBe(503);
      expect(enqueueSignal!.aborted).toBe(true);
    }, server => server.registerEnqueuer(enqueuer));
  });

  test('rate limits authenticated sources per IP', async () => {
    const send = mock(async () => {});
    await withServer({ WEBHOOK_RATE_LIMIT_MAX: '1' }, async (_server, baseUrl) => {
      const send = async () => Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': SECRET },
        body: JSON.stringify({ room_id: '100', text: 'hello' }),
      });
      expect((await send()).status).toBe(200);
      const limited = await send();
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    }, server => server.registerSender('discord', send));
  });

  test('enforces the configured request body limit', async () => {
    await withServer({ WEBHOOK_MAX_BODY_BYTES: '1024' }, async (_server, baseUrl) => {
      const response = await Bun.fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': SECRET },
        body: JSON.stringify({ room_id: '100', text: 'x'.repeat(2048) }),
      });
      expect(response.status).toBe(413);
    });
  });

  test('preserves signed GitHub delivery on both compatible routes', async () => {
    const send = mock(async () => {});
    const body = JSON.stringify({
      room_id: '100',
      ref: 'refs/heads/main',
      repository: { full_name: 'owner/repo' },
      commits: [],
    });
    const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    await withServer({}, async (_server, baseUrl) => {
      for (const path of ['/webhook', '/webhook/github']) {
        const response = await Bun.fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'push',
            'X-GitHub-Delivery': `delivery-${path.length}`,
            'X-Hub-Signature-256': signature,
          },
          body,
        });
        expect(response.status).toBe(200);
      }
    }, server => server.registerSender('discord', send));
  });

  test('rejects invalid numeric and boolean webhook configuration at startup', async () => {
    await withEnvironment({ ...BASE_ENV, WEBHOOK_RATE_LIMIT_MAX: '1.5' }, () => {
      const server = new WebhookServer();
      expect(() => server.start()).toThrow('WEBHOOK_RATE_LIMIT_MAX');
    });
    await withEnvironment({ ...BASE_ENV, WEBHOOK_ENABLED: 'yes' }, () => {
      const server = new WebhookServer();
      expect(() => server.start()).toThrow('WEBHOOK_ENABLED');
    });
  });
});
