import { MessageContext } from '../core/MessageContext';

export interface BotProvider {
  /**
   * Name of the provider ('whatsapp' or 'discord')
   */
  name: 'whatsapp' | 'discord';

  /**
   * Start the bot connection
   */
  start(): Promise<void>;

  /**
   * Stop/Gracefully kill the connection
   */
  stop(): Promise<void>;

  /**
   * Register a callback for incoming messages
   */
  onMessage(handler: (ctx: MessageContext) => Promise<void>): void;
}
