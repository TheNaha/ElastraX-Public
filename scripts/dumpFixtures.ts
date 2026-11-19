#!/usr/bin/env bun
/**
 * scripts/dumpFixtures.ts
 *
 * Standalone script:  bun run fixtures:dump [--force]
 *
 * Reads recent WhatsApp `raw_message` rows, runs each through
 * `parseWhatsAppMessage()`, then writes one representative JSON fixture per
 * unique messageType to `test/fixtures/wa_messages/<messageType>.json`
 * (or `FIXTURE_DUMP_DIR`).
 *
 * The dumping itself is `dumpFixtures()` in `src/runtime/startupDiagnostics.ts`,
 * which owns the production guard, the bounded row read, the 0700/0600 modes and
 * the unwritable-directory handling. This file only parses arguments and prints
 * the coverage report; it used to carry a second, unbounded implementation that
 * ignored `FIXTURE_DUMP_DIR` and wrote world-readable files.
 */

import { dumpFixtures } from '../src/runtime/startupDiagnostics';

const FORCE = process.argv.includes('--force');

async function main(): Promise<void> {
  console.log('📦  ElastraX fixture dumper\n');
  const summary = await dumpFixtures(null, { force: FORCE });
  if (!summary) {
    console.log('No fixture candidates found (nothing dumped).');
    return;
  }

  const { coverage, written, skipped, fixtureDir } = summary;
  const bar = '─'.repeat(60);
  console.log(`\n${bar}\nCOVERAGE REPORT\n${bar}`);
  console.log(`Total messages scanned:  ${coverage.total}`);
  console.log(`Unique message types:    ${coverage.uniqueByType.size}`);
  console.log(`Parse errors:            ${coverage.errors.length}`);
  console.log(`Unknown type samples:    ${coverage.unknownSamples.length}\n`);

  console.log('✅  Types covered:');
  for (const type of [...coverage.uniqueByType.keys()].sort()) {
    const status = written.includes(`${type}.json`) ? '  [NEW]  ' : ' [EXIST] ';
    console.log(`  ${status} ${type}`);
  }

  if (coverage.errors.length > 0) {
    console.log('\n❌  Parse errors (first 5):');
    for (const { error, raw } of coverage.errors.slice(0, 5)) {
      const key = (raw as { key?: { id?: unknown } } | null)?.key;
      const id = typeof key?.id === 'string' ? key.id : '?';
      console.log(`  [msg ${id}] ${error.message}`);
    }
  }

  if (coverage.unknownSamples.length > 0) {
    console.log('\n⚠️   Unknown type samples (first 5):');
    for (const { raw } of coverage.unknownSamples.slice(0, 5)) {
      const body = (raw as { message?: Record<string, unknown> } | null)?.message;
      const keys = Object.keys(body ?? {}).join(', ') || '(no message body)';
      console.log(`  keys: ${keys}`);
    }
  }

  console.log(`\n${bar}`);
  if (written.length > 0) {
    console.log(`\n📁  Wrote ${written.length} fixture(s) to ${fixtureDir}`);
    written.forEach(file => console.log(`    + ${file}`));
  }
  if (skipped.length > 0) {
    console.log(`\n⏭   Skipped ${skipped.length} existing fixture(s) (use --force to overwrite)`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
