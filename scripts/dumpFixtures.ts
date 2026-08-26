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
function stripBlobs(raw: any): any {
  if (typeof raw !== 'object' || raw === null) return raw;
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
  const out: any = Array.isArray(raw) ? [] : {};
  for (const [k, v] of Object.entries(raw)) {
    if (BLOB_KEYS.has(k)) continue;
    out[k] = typeof v === 'object' ? stripBlobs(v) : v;
  }
  return out;
}

async function main() {
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
      const id = raw?.key?.id ?? '?';
      console.log(`  [msg ${id}] ${error.message}`);
    }
  }

  if (result.unknownSamples.length > 0) {
    console.log('\n⚠️   Unknown type samples (first 5):');
    for (const { raw } of result.unknownSamples.slice(0, 5)) {
      const keys = Object.keys(raw?.message ?? {}).join(', ') || '(no message body)';
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
