import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { safeSecretCompare, verifyGitHubSignature } from '../src/webhooks/utils';

describe('webhook constant-time comparison', () => {
  test('accepts identical secrets and rejects different values or lengths', () => {
    expect(safeSecretCompare('correct-secret', 'correct-secret')).toBe(true);
    expect(safeSecretCompare('correct-secre', 'correct-secret')).toBe(false);
    expect(safeSecretCompare('correct-secret-longer', 'correct-secret')).toBe(false);
    expect(safeSecretCompare('', 'correct-secret')).toBe(false);
  });

  test('verifies a GitHub signature over the exact payload', () => {
    const payload = '{"action":"opened"}';
    const secret = 'github-webhook-secret';
    const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    expect(verifyGitHubSignature(payload, secret, signature)).toBe(true);
    expect(verifyGitHubSignature(`${payload} `, secret, signature)).toBe(false);
  });
});
