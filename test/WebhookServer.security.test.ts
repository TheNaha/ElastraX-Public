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

import { verifyGitHubSignature, WebhookServer } from '../src/webhookServer';

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
});
