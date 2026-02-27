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

import { WhatsAppProvider } from './providers/whatsapp';
import { DiscordProvider } from './providers/discord';
import { handleIncomingMessage } from './agent';
import { MessageContext } from './core/MessageContext';
import { logger } from './utils/logger';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { db } from './db';
import { messages } from './db/schema';
import { scanParserCoverage, logCoverageSummary } from './utils/parserCoverage';
import { writeFile, mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { validateEnv } from './config/env';
import { Scheduler } from './utils/Scheduler';
import { WebhookServer } from './webhookServer';
import { RateLimiter } from './utils/RateLimiter';
import { MediaCleanup } from './utils/MediaCleanup';
import { MessageQueue } from './utils/MessageQueue';
import { SessionManager } from './utils/SessionManager';
import { healthMetrics } from './utils/HealthMetrics';

// Per-room message queue — ensures sequential processing within each chat room.
const messageQueue = new MessageQueue();

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

  try {
    await mkdir(FIXTURE_DIR, { recursive: true });
  } catch (err: any) {
    if (err?.code === 'EACCES' || err?.code === 'EROFS') {
      logger.warn({ path: FIXTURE_DIR, code: err.code }, '[FixtureDumper] Fixture directory is not writable; skipping fixture dump.');
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
    } catch (err: any) {
      if (err?.code === 'EACCES' || err?.code === 'EROFS') {
        logger.warn({ path: filepath, code: err.code }, '[FixtureDumper] Cannot write fixture file; skipping remaining fixture dump.');
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
    migrate(db, { migrationsFolder: './drizzle/migrations' });
    logger.info('Database migrations applied successfully.');
  } catch (err: any) {
    logger.error(err, 'Failed to run database migrations');
    process.exit(1);
  }

  // Restore persisted flow sessions from SQLite so multi-step wizards survive restarts.
  await SessionManager.initialize();

  // Initialize providers
  const waProvider = new WhatsAppProvider();
  const discordProvider = new DiscordProvider();

  // Register the core conversational agent handler, wrapped in a per-room queue
  // so messages in the same chat are processed sequentially (avoids race conditions).
  const queuedHandler = async (ctx: MessageContext): Promise<void> => {
    messageQueue.enqueue(ctx.chatId, () => handleIncomingMessage(ctx));
  };

  waProvider.onMessage(queuedHandler);
  discordProvider.onMessage(queuedHandler);

  // Start providers
  await waProvider.start();
  await discordProvider.start();

  // ── Webhook Inbound Server ──────────────────────────────────────────────────
  const webhookServer = new WebhookServer();
  // Register provider senders so the webhook can route messages to chats
  webhookServer.registerSender('whatsapp', async (chatId, text) => {
    // Access WhatsApp sock via the provider's public send method (implemented below)
    await waProvider.sendMessage(chatId, text);
  });
  webhookServer.registerSender('discord', async (chatId, text) => {
    await discordProvider.sendMessage(chatId, text);
  });
  webhookServer.start();

  // ── Scheduler (reminders) ───────────────────────────────────────────────────
  Scheduler.registerSender('whatsapp', async (chatId, text) => {
    await waProvider.sendMessage(chatId, text);
  });
  Scheduler.registerSender('discord', async (chatId, text) => {
    await discordProvider.sendMessage(chatId, text);
  });
  Scheduler.start();

  // ── Rate Limiter pruning ────────────────────────────────────────────────────
  // Clean up stale rate-limit buckets every 10 minutes
  setInterval(() => RateLimiter.prune(), 10 * 60 * 1000);

  // ── Media cache pruning ─────────────────────────────────────────────────────
  const mediaCleanupIntervalMs = parseInt(process.env.MEDIA_CLEANUP_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
  setInterval(() => {
    MediaCleanup.pruneOldFiles().catch((err) => {
      logger.warn({ err }, '[MediaCleanup] Periodic prune failed');
    });
  }, mediaCleanupIntervalMs);

  logger.info('Bot is running. Press Ctrl+C to stop.');

  // Background startup scan — runs after providers are up, never blocks
  // Use a short delay so the socket user object is populated
  setTimeout(() => {
    // WhatsApp provider exposes sock.user via the public getter if needed;
    // for now we pass null (still catches structural errors and type gaps)
    runStartupCoverageScan(null);
  }, 5000);

  let shuttingDown = false;
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM') => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down gracefully...');

    // Dump fixtures before exit so the test suite grows automatically
    await dumpFixtures(null).catch(err => {
      logger.error(err, `[FixtureDumper] Failed during ${signal} — fixtures may be incomplete`);
    });

    Scheduler.stop();
    webhookServer.stop();
    messageQueue.stop();

    await waProvider.stop();
    await discordProvider.stop();
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
