import { WhatsAppProvider } from './providers/whatsapp';
import { DiscordProvider } from './providers/discord';
import { handleIncomingMessage } from './agent';
import { logger } from './utils/logger';

async function main() {
  logger.info('Starting ElastraX v7...');

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

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');
    await waProvider.stop();
    await discordProvider.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(err, 'Fatal error during startup');
  process.exit(1);
});
