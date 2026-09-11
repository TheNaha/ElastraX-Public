import { describe, test, expect, mock } from 'bun:test';
import { createHmac } from 'crypto';

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

describe('WebhookServer Security', () => {
  const secret = 'test-secret';
  const payload = JSON.stringify({ action: 'push', repository: { full_name: 'test/repo' } });
  const validSignature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;

  test('verifyGitHubSignature should accept a valid signature', () => {
    expect(verifyGitHubSignature(payload, secret, validSignature)).toBe(true);
  });

  test('verifyGitHubSignature should reject an empty signature', () => {
    expect(verifyGitHubSignature(payload, secret, null)).toBe(false);
    expect(verifyGitHubSignature(payload, secret, '')).toBe(false);
  });

  test('verifyGitHubSignature should reject a signature with wrong prefix', () => {
    const wrongPrefix = validSignature.replace('sha256=', 'sha1=');
    expect(verifyGitHubSignature(payload, secret, wrongPrefix)).toBe(false);
  });

  test('verifyGitHubSignature should reject an invalid signature of the same length', () => {
    const invalidSignature = validSignature.replace(/.$/, validSignature.endsWith('0') ? '1' : '0');
    expect(verifyGitHubSignature(payload, secret, invalidSignature)).toBe(false);
  });

  test('verifyGitHubSignature should reject a signature of different length', () => {
    const shortSignature = 'sha256=abcd';
    const longSignature = validSignature + ' extra';
    expect(verifyGitHubSignature(payload, secret, shortSignature)).toBe(false);
    expect(verifyGitHubSignature(payload, secret, longSignature)).toBe(false);
  });

  test('WebhookServer should safely reject non-string shared secrets', async () => {
    process.env.WEBHOOK_ENABLED = 'true';
    process.env.WEBHOOK_SECRET = secret;
    process.env.WEBHOOK_PORT = '0';

    const server = new WebhookServer();
    server.registerSender('discord', async () => {});
    server.start();

    try {
      const internalServer = server as unknown as { server?: { port?: number } };
      const port = internalServer.server?.port;
      expect(typeof port).toBe('number');

      const res = await fetch(`http://127.0.0.1:${port}/webhook?room_id=123456`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'hello',
          secret: { nested: true },
        }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('Invalid or missing secret');
    } finally {
      server.stop();
      delete process.env.WEBHOOK_ENABLED;
      delete process.env.WEBHOOK_SECRET;
      delete process.env.WEBHOOK_PORT;
    }
  });

  test('WebhookServer exposes health and metrics endpoints', async () => {
    process.env.WEBHOOK_ENABLED = 'true';
    process.env.WEBHOOK_SECRET = secret;
    process.env.WEBHOOK_PORT = '0';

    const server = new WebhookServer();
    server.start();

    try {
      const internalServer = server as unknown as { server?: { port?: number } };
      const port = internalServer.server?.port;

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);

      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toContain('elastrax_');
    } finally {
      server.stop();
      delete process.env.WEBHOOK_ENABLED;
      delete process.env.WEBHOOK_SECRET;
      delete process.env.WEBHOOK_PORT;
    }
  });

  test('WebhookServer returns 503 when secret is not configured', async () => {
    process.env.WEBHOOK_ENABLED = 'true';
    process.env.WEBHOOK_PORT = '0';

    const server = new WebhookServer();
    server.start();

    try {
      const internalServer = server as unknown as { server?: { port?: number } };
      const port = internalServer.server?.port;
      const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello', room_id: '123456' }),
      });

      expect(res.status).toBe(503);
    } finally {
      server.stop();
      delete process.env.WEBHOOK_ENABLED;
      delete process.env.WEBHOOK_PORT;
    }
  });

  test('WebhookServer rejects missing room ids', async () => {
    process.env.WEBHOOK_ENABLED = 'true';
    process.env.WEBHOOK_SECRET = secret;
    process.env.WEBHOOK_PORT = '0';

    const server = new WebhookServer();
    server.registerSender('discord', async () => {});
    server.start();

    try {
      const internalServer = server as unknown as { server?: { port?: number } };
      const port = internalServer.server?.port;
      const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello', secret }),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('room_id');
    } finally {
      server.stop();
      delete process.env.WEBHOOK_ENABLED;
      delete process.env.WEBHOOK_SECRET;
      delete process.env.WEBHOOK_PORT;
    }
  });

  test('WebhookServer returns 207 when only some deliveries succeed', async () => {
    process.env.WEBHOOK_ENABLED = 'true';
    process.env.WEBHOOK_SECRET = secret;
    process.env.WEBHOOK_PORT = '0';

    const server = new WebhookServer();
    server.registerSender('discord', async (roomId) => {
      if (roomId === '222') throw new Error('blocked');
    });
    server.start();

    try {
      const internalServer = server as unknown as { server?: { port?: number } };
      const port = internalServer.server?.port;
      const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_ids: ['111', '222'], text: 'hello', secret, platform: 'discord' }),
      });

      expect(res.status).toBe(207);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.delivered).toBe(1);
      expect(body.failed).toHaveLength(1);
    } finally {
      server.stop();
      delete process.env.WEBHOOK_ENABLED;
      delete process.env.WEBHOOK_SECRET;
      delete process.env.WEBHOOK_PORT;
    }
  });

  test('WebhookServer routes successful webhook deliveries to ok=true', async () => {
    process.env.WEBHOOK_ENABLED = 'true';
    process.env.WEBHOOK_SECRET = secret;
    process.env.WEBHOOK_PORT = '0';

    const sendDiscord = mock(async () => {});
    const server = new WebhookServer();
    server.registerSender('discord', sendDiscord);
    server.start();

    try {
      const internalServer = server as unknown as { server?: { port?: number } };
      const port = internalServer.server?.port;
      const res = await fetch(`http://127.0.0.1:${port}/webhook?room_id=123456&secret=${secret}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Alert', body: 'Something happened' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, delivered: 1 });
      expect(sendDiscord).toHaveBeenCalledTimes(1);
    } finally {
      server.stop();
      delete process.env.WEBHOOK_ENABLED;
      delete process.env.WEBHOOK_SECRET;
      delete process.env.WEBHOOK_PORT;
    }
  });
});
