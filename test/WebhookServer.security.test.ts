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

import { verifyGitHubSignature } from '../src/webhookServer';

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
});
