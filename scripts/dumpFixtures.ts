#!/usr/bin/env bun
/**
 * scripts/dumpFixtures.ts
 *
 * Standalone script:  bun run fixtures:dump [--force]
 *
 * Reads every `raw_message` from the SQLite database, runs each through
 * `parseWhatsAppMessage()`, then writes one representative JSON fixture per
 * unique messageType to `test/fixtures/wa_messages/<messageType>.json`.
 *
 * Rules for overwriting an existing fixture:
 *  - Only overwrite if the new sample has no large binary blobs
 *    (jpegThumbnail, firstFrameSidecar, mediaKey, fileSha256 stripped from
 *    the output so fixtures stay readable in the repo).
 *  - Never overwrite hand-crafted fixtures that already have no such blobs,
 *    unless the existing file's messageType no longer matches.
 *
 * After writing, it prints a table to stdout showing which types are covered
 * and which raised errors, so you know where the parser has gaps.
 */

import { db } from '../src/db';
import { messages } from '../src/db/schema';
import { scanParserCoverage } from '../src/utils/parserCoverage';
import { writeFile, mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';

// ─── Config ──────────────────────────────────────────────────────────────────
const FIXTURE_DIR = resolve('./test/fixtures/wa_messages');
const FORCE = process.argv.includes('--force');

/**
 * Strip large binary fields that make fixtures unreadable and bloat the repo.
 * We keep all structural fields intact so the parser can still process them.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function stripBlobs(raw: unknown): JsonValue {
  if (typeof raw !== 'object' || raw === null) return raw as JsonValue;
  const BLOB_KEYS = new Set([
    'jpegThumbnail',
    'firstFrameSidecar',
    'mediaKey',
    'fileSha256',
    'fileEncSha256',
    'scansSidecar',
    'midQualityFileSha256',
    'messageSecret',
    'senderKeyHash',
    'recipientKeyHash',
    'deviceListMetadata',
  ]);
  const out: JsonValue = Array.isArray(raw) ? [] : {};
  for (const [k, v] of Object.entries(raw)) {
    if (BLOB_KEYS.has(k)) continue;
    if (Array.isArray(out) || out === null || typeof out !== 'object') continue;
    out[k] = typeof v === 'object' && v !== null ? stripBlobs(v) : (v as JsonValue);
  }
  return out;
}

async function main() {
  // Same guard as startupDiagnostics.dumpFixtures. Without it this script had no
  // protection at all, so `bun run scripts/dumpFixtures.ts` in production copied
  // real WhatsApp message payloads out of the live database and into the repo.
  // The npm script sets both variables, but the guard has to live here: the file
  // is directly invokable.
  if (process.env.NODE_ENV === 'production' || process.env.ALLOW_FIXTURE_DUMP !== 'true') {
    throw new Error('Fixture dumping is disabled outside an explicit development environment');
  }

  console.log('📦  ElastraX fixture dumper\n');
  console.log('Reading messages from database...');

  const rows = db.select({
    rawMessage: messages.rawMessage,
    providerMessageId: messages.providerMessageId,
  }).from(messages).all();

  console.log(`Found ${rows.length} rows. Scanning...\n`);

  const result = await scanParserCoverage(rows, null /* offline — no bot JID */);

  await mkdir(FIXTURE_DIR, { recursive: true });

  // ── Write fixtures ──────────────────────────────────────────────────────
  const written: string[] = [];
  const skipped: string[] = [];

  for (const [messageType, { raw }] of result.uniqueByType) {
    const filename = `${messageType}.json`;
    const filepath = join(FIXTURE_DIR, filename);
    const clean = stripBlobs(raw);

    // Don't overwrite if already exists AND looks externally managed (has no URL field)
    if (existsSync(filepath) && !FORCE) {
      skipped.push(filename);
      continue;
    }

    await writeFile(filepath, JSON.stringify(clean, null, 2), 'utf-8');
    written.push(filename);
  }

  // ── Print report ─────────────────────────────────────────────────────────
  console.log('─'.repeat(60));
  console.log('COVERAGE REPORT');
  console.log('─'.repeat(60));
  console.log(`Total messages scanned:  ${result.total}`);
  console.log(`Unique message types:    ${result.uniqueByType.size}`);
  console.log(`Parse errors:            ${result.errors.length}`);
  console.log(`Unknown type samples:    ${result.unknownSamples.length}`);
  console.log('');

  console.log('✅  Types covered:');
  for (const type of [...result.uniqueByType.keys()].sort()) {
    const status = written.includes(`${type}.json`) ? '  [NEW]  ' : ' [EXIST] ';
    console.log(`  ${status} ${type}`);
  }

  if (result.errors.length > 0) {
    console.log('\n❌  Parse errors (first 5):');
    for (const { error, raw } of result.errors.slice(0, 5)) {
      const key = (raw as { key?: { id?: unknown } } | null)?.key;
      const id = typeof key?.id === 'string' ? key.id : '?';
      console.log(`  [msg ${id}] ${error.message}`);
    }
  }

  if (result.unknownSamples.length > 0) {
    console.log('\n⚠️   Unknown type samples (first 5):');
    for (const { raw } of result.unknownSamples.slice(0, 5)) {
      const body = (raw as { message?: Record<string, unknown> } | null)?.message;
      const keys = Object.keys(body ?? {}).join(', ') || '(no message body)';
      console.log(`  keys: ${keys}`);
    }
  }

  console.log('\n─'.repeat(60));
  if (written.length > 0) {
    console.log(`\n📁  Wrote ${written.length} new fixture(s) to ${FIXTURE_DIR}`);
    written.forEach(f => console.log(`    + ${f}`));
  }
  if (skipped.length > 0) {
    console.log(`\n⏭   Skipped ${skipped.length} existing fixture(s) (use --force to overwrite)`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
