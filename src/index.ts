import { WhatsAppProvider } from './providers/whatsapp';
import { DiscordProvider } from './providers/discord';
import { handleIncomingMessage } from './agent';
import { logger } from './utils/logger';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { db } from './db';
import { messages } from './db/schema';
import { scanParserCoverage, logCoverageSummary } from './utils/parserCoverage';
import { writeFile, mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';

const FIXTURE_DIR = resolve('./test/fixtures/wa_messages');

// ─── Blob fields that make fixture files large and unreadable in the repo ───
const BLOB_KEYS = new Set([
  'jpegThumbnail', 'firstFrameSidecar', 'mediaKey', 'fileSha256',
  'fileEncSha256', 'scansSidecar', 'midQualityFileSha256', 'messageSecret',
  'senderKeyHash', 'recipientKeyHash', 'deviceListMetadata',
]);

function stripBlobs(raw: any): any {
  if (typeof raw !== 'object' || raw === null) return raw;
  const out: any = Array.isArray(raw) ? [] : {};
  for (const [k, v] of Object.entries(raw)) {
    if (BLOB_KEYS.has(k)) continue;
    out[k] = typeof v === 'object' ? stripBlobs(v) : v;
  }
  return out;
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

  await mkdir(FIXTURE_DIR, { recursive: true });
  let written = 0;

  for (const [messageType, { raw }] of result.uniqueByType) {
    const filepath = join(FIXTURE_DIR, `${messageType}.json`);
    if (existsSync(filepath)) continue; // don't overwrite existing fixtures
    await writeFile(filepath, JSON.stringify(stripBlobs(raw), null, 2), 'utf-8');
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
  logger.info('Starting ElastraX v7...');

  try {
    logger.info('Running database migrations...');
    migrate(db, { migrationsFolder: './drizzle/migrations' });
    logger.info('Database migrations applied successfully.');
  } catch (err: any) {
    logger.error(err, 'Failed to run database migrations');
    process.exit(1);
  }

  // Initialize providers
  const waProvider = new WhatsAppProvider();
  const discordProvider = new DiscordProvider();

  // Register the core conversational agent handler
  waProvider.onMessage(handleIncomingMessage);
  discordProvider.onMessage(handleIncomingMessage);

  // Start providers
  await waProvider.start();
  await discordProvider.start();

  logger.info('Bot is running. Press Ctrl+C to stop.');

  // Background startup scan — runs after providers are up, never blocks
  // Use a short delay so the socket user object is populated
  setTimeout(() => {
    // WhatsApp provider exposes sock.user via the public getter if needed;
    // for now we pass null (still catches structural errors and type gaps)
    runStartupCoverageScan(null);
  }, 5000);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');

    // Dump fixtures before exit so the test suite grows automatically
    await dumpFixtures(null).catch(err => {
      logger.error(err, '[FixtureDumper] Failed during SIGINT — fixtures may be incomplete');
    });

    await waProvider.stop();
    await discordProvider.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(err, 'Fatal error during startup');
  process.exit(1);
});
