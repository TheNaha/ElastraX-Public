/**
 * test/setup.ts – bun test preload file
 *
 * This file is executed by the bun test runner before any test modules are
 * loaded.  Setting AI env vars here ensures that the AIClient singleton
 * created at module-evaluation time in src/agent/index.ts picks up a valid
 * base URL, so chatCompletion() proceeds to the fetch() call (which is then
 * intercepted per-test via global.fetch mock).
 *
 * It also ensures libsignal stub files exist so that @whiskeysockets/baileys
 * can be imported without the native 'libsignal' binary (unavailable in CI).
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

process.env.AI_API_BASE_URL = 'https://test-ai.example.com/v1';
process.env.AI_API_KEY = 'test-key';
process.env.AI_MODEL_NAME = 'test-model';
process.env.ELASTRAX_DB_PATH = ':memory:';

// ─── libsignal stubs ─────────────────────────────────────────────────────────
// @whiskeysockets/baileys requires the 'libsignal' native binary package.
// In CI / dev environments where the native build is unavailable, we create
// minimal stub files so Bun can resolve the imports without error.
// Signal Protocol cryptography is never exercised in unit tests.

const libsignalRoot = join(import.meta.dir, '..', 'node_modules', 'libsignal');

if (!existsSync(join(libsignalRoot, 'index.js'))) {
  mkdirSync(join(libsignalRoot, 'src'), { recursive: true });

  writeFileSync(
    join(libsignalRoot, 'package.json'),
    JSON.stringify({ name: 'libsignal', version: '0.0.0', main: 'index.js', type: 'module' }),
  );

  writeFileSync(
    join(libsignalRoot, 'index.js'),
    `export class SessionCipher { async decryptPreKeyWhisperMessage() { return Buffer.alloc(0); } async decryptWhisperMessage() { return Buffer.alloc(0); } async encrypt() { return { type: 1, body: '' }; } async getRecord() { return null; } async hasOpenSession() { return false; } async deleteAllSessionsForDevice() {} }
export class SessionBuilder { async initOutgoing() {} async processPreKey() {} }
export class SessionRecord { static deserialize() { return new SessionRecord(); } serialize() { return Buffer.alloc(0); } }
export class ProtocolAddress { constructor(n, d) { this.name = n; this.deviceId = d; } getName() { return this.name; } getDeviceId() { return this.deviceId; } toString() { return this.name + '.' + this.deviceId; } }
`,
  );

  const curveStub = `export function generateKeyPair() { return { pubKey: Buffer.alloc(33), privKey: Buffer.alloc(32) }; }
export function calculateAgreement() { return Buffer.alloc(32); }
export function calculateSignature() { return Buffer.alloc(64); }
export function verifySignature() { return true; }
export function createKeyPair(p) { return { pubKey: Buffer.alloc(33), privKey: p || Buffer.alloc(32) }; }
export default { generateKeyPair, calculateAgreement, calculateSignature, verifySignature, createKeyPair };
`;
  writeFileSync(join(libsignalRoot, 'src', 'curve.js'), curveStub);

  const cryptoStub = `export function calculateMAC() { return Buffer.alloc(32); }
export function deriveSecrets(_i, _s, _n, chunks) { return Array.from({ length: chunks || 3 }, () => Buffer.alloc(32)); }
export function decrypt() { return Buffer.alloc(0); }
export function encrypt() { return Buffer.alloc(0); }
export function hmacSha256() { return Buffer.alloc(32); }
`;
  writeFileSync(join(libsignalRoot, 'src', 'crypto.js'), cryptoStub);
}
