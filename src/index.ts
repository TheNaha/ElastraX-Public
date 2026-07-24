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
import { ensureDatabaseSchema } from './db';
import { validateEnv } from './config/env';
import { SessionManager } from './utils/SessionManager';
import { AppRuntime } from './runtime/AppRuntime';
import { dumpFixtures, runStartupCoverageScan } from './runtime/startupDiagnostics';

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
    await Promise.race([
      dumpFixtures(null),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
    ]).catch(err => {
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
