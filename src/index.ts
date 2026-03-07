/**
 * @file src/index.ts
 * @description Application entry point for ElastraX v7.
 *
 * Responsibilities:
 *  1. Validate required environment variables (fail fast on misconfiguration).
 *  2. Run Drizzle ORM database migrations on startup.
 *  3. Instantiate and start all messaging platform providers (WhatsApp, Discord).
 *  4. Wire each provider's incoming-message event to the core AI agent handler.
 *  5. On graceful shutdown (SIGINT / Ctrl-C):
 *       - Dump representative WAMessage fixture files to test/fixtures/wa_messages/
 *         so the parser test suite can grow automatically over time.
 *       - Stop all providers cleanly.
 *  6. Run a lightweight parser-coverage scan 5 seconds after startup so that
 *     any message-type gaps are surfaced in the logs without blocking boot.
 */

import { logger } from './utils/logger';
import { db, ensureDatabaseSchema } from './db';
import { messages } from './db/schema';
import { scanParserCoverage, logCoverageSummary } from './utils/parserCoverage';
import { writeFile, mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { validateEnv } from './config/env';
import { SessionManager } from './utils/SessionManager';
import { AppRuntime } from './runtime/AppRuntime';

// Directory where one JSON fixture file per WAMessage type will be written.
const FIXTURE_DIR = process.env.FIXTURE_DUMP_DIR?.trim()
  || (process.env.NODE_ENV === 'production'
    ? resolve('./data/fixtures/wa_messages')
    : resolve('./test/fixtures/wa_messages'));

// ─── Blob fields that make fixture files large and unreadable in the repo ───
const BLOB_KEYS = new Set([
  'jpegThumbnail', 'firstFrameSidecar', 'mediaKey', 'fileSha256',
  'fileEncSha256', 'scansSidecar', 'midQualityFileSha256', 'messageSecret',
  'senderKeyHash', 'recipientKeyHash', 'deviceListMetadata',
]);

/**
 * Recursively strips binary-blob fields from a raw WAMessage object so that
 * the resulting JSON fixture file is small and human-readable.
 * Fields listed in BLOB_KEYS are removed entirely; all other values are kept.
 */
type JsonLike = Record<string, unknown> | unknown[];

function stripBlobs(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const out: JsonLike = Array.isArray(raw) ? [] : {};
  for (const [k, v] of Object.entries(raw)) {
    if (BLOB_KEYS.has(k)) continue;
    if (Array.isArray(out)) {
      out.push(typeof v === 'object' ? stripBlobs(v) : v);
    } else {
      out[k] = typeof v === 'object' ? stripBlobs(v) : v;
    }
  }
  return out;
}

function getErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/**
 * Dump one fixture JSON per unique messageType to test/fixtures/wa_messages/.
 * Skips existing files so hand-crafted fixtures are preserved.
 */
async function dumpFixtures(botUserId: string | null): Promise<void> {
  logger.info('[FixtureDumper] Reading messages from database...');

  const rows = db.select({
    rawMessage: messages.rawMessage,
    providerMessageId: messages.providerMessageId,
  }).from(messages).all();

  if (rows.length === 0) {
    logger.info('[FixtureDumper] No messages in database, skipping fixture dump.');
    return;
  }

  const result = await scanParserCoverage(rows, botUserId);
  logCoverageSummary(result);

  try {
    await mkdir(FIXTURE_DIR, { recursive: true });
  } catch (err: unknown) {
    const code = getErrorCode(err);
    if (code === 'EACCES' || code === 'EROFS') {
      logger.warn({ path: FIXTURE_DIR, code }, '[FixtureDumper] Fixture directory is not writable; skipping fixture dump.');
      return;
    }
    throw err;
  }
  let written = 0;

  for (const [messageType, { raw }] of result.uniqueByType) {
    const filepath = join(FIXTURE_DIR, `${messageType}.json`);
    if (existsSync(filepath)) continue; // don't overwrite existing fixtures
    try {
      await writeFile(filepath, JSON.stringify(stripBlobs(raw), null, 2), 'utf-8');
    } catch (err: unknown) {
      const code = getErrorCode(err);
      if (code === 'EACCES' || code === 'EROFS') {
        logger.warn({ path: filepath, code }, '[FixtureDumper] Cannot write fixture file; skipping remaining fixture dump.');
        return;
      }
      throw err;
    }
    logger.info(`[FixtureDumper] Wrote ${messageType}.json`);
    written++;
  }

  logger.info(`[FixtureDumper] Done. Wrote ${written} new fixture(s), skipped ${result.uniqueByType.size - written} existing.`);

  if (result.errors.length > 0 || result.unknownSamples.length > 0) {
    logger.warn('[FixtureDumper] ⚠  Parser gaps detected — see logs above. Run "bun run fixtures:dump" for a full report.');
  }
}

/**
 * Run a quick parser coverage scan in the background after the bot connects.
 * Does NOT block startup. Logs a warning summary if gaps are found.
 */
async function runStartupCoverageScan(botUserId: string | null): Promise<void> {
  try {
    const rows = db.select({
      rawMessage: messages.rawMessage,
      providerMessageId: messages.providerMessageId,
    }).from(messages).limit(2000).all(); // cap to avoid slowing startup

    if (rows.length === 0) return;

    const result = await scanParserCoverage(rows, botUserId);
    logCoverageSummary(result);
  } catch (err) {
    logger.warn({ err }, '[ParserCoverage] Startup scan failed (non-fatal)');
  }
}

async function main() {
  validateEnv();
  logger.info('Starting ElastraX v7...');

  try {
    logger.info('Running database migrations...');
    ensureDatabaseSchema();
    logger.info('Database migrations applied successfully.');
  } catch (err: unknown) {
    logger.error(err, 'Failed to run database migrations');
    process.exit(1);
  }

  // Restore persisted flow sessions from SQLite so multi-step wizards survive restarts.
  await SessionManager.initialize();

  const runtime = new AppRuntime({
    runStartupCoverageScan: async () => runStartupCoverageScan(null),
  });
  await runtime.start();

  let shuttingDown = false;
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM') => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down gracefully...');

    // Dump fixtures before exit so the test suite grows automatically
    await dumpFixtures(null).catch(err => {
      logger.error(err, `[FixtureDumper] Failed during ${signal} — fixtures may be incomplete`);
    });

    await runtime.stop();
    process.exit(0);
  };

  // Handle graceful shutdown
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(err, 'Fatal error during startup');
  process.exit(1);
});
