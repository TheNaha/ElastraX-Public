/**
 * test/netAddress.test.ts
 *
 * Host classification decides whether a credential-bearing endpoint may use
 * plain http (`ALLOW_INSECURE_HTTP_ENDPOINTS` covers the rest), so the range
 * boundaries are worth pinning: an over-broad rule would accept a public
 * address, an under-broad one rejects a working LAN deployment.
 */

import { describe, expect, test } from 'bun:test';
import { isLoopbackHost, isPrivateHost } from '../src/utils/netAddress';

describe('isLoopbackHost', () => {
  test.each([
    '127.0.0.1',
    '127.1.2.3',
    'localhost',
    'localhost.',
    '::1',
    '[::1]',
    'LOCALHOST',
  ])('accepts %s', host => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  test.each(['192.168.1.1', '10.0.0.1', 'example.com', '::ffff:127.0.0.1', ''])('rejects %s', host => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('isPrivateHost', () => {
  test.each([
    '10.0.0.5',
    '10.255.255.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.10',
    '169.254.10.20',
    // 100.64.0.0/10 shared space (CGNAT, Tailscale).
    '100.64.0.1',
    '100.127.255.254',
    // IPv6 unique-local and link-local, with and without URL brackets.
    'fd00::5',
    '[fd12:3456::1]',
    'fc00::1',
    'fe80::1',
    'febf::1',
    // IPv4-mapped IPv6 keeps the v4 rules.
    '::ffff:192.168.1.5',
    // Loopback is private too.
    '127.0.0.1',
    '::1',
    'localhost',
  ])('accepts %s', host => {
    expect(isPrivateHost(host)).toBe(true);
  });

  test.each([
    // The upper bound of the shared block is exclusive: 100.128 is public.
    '100.128.0.1',
    // A real deployment's inference host, and a public address.
    '100.150.0.4',
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '192.169.0.1',
    '2001:db8::1',
    'fe00::1',
    // Names are never classified: a name can resolve anywhere.
    'inference.corp.example',
    'whisper.lan',
    'example.com',
    '',
  ])('rejects %s', host => {
    expect(isPrivateHost(host)).toBe(false);
  });
});
