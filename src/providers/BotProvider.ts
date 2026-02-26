/**
 * @file src/providers/BotProvider.ts
 * @description Abstract interface that every messaging-platform provider must implement.
 *
 * ElastraX is platform-agnostic by design: the `BotProvider` interface decouples the
 * core AI agent from the specifics of any particular messaging API (WhatsApp, Discord, …).
 *
 * To add a new platform:
 *  1. Create a class that implements `BotProvider`.
 *  2. Inside `start()`, connect to the platform and, for every incoming user message,
 *     construct a `MessageContext` and call the registered `messageHandler`.
 *  3. Instantiate the provider in `src/index.ts` and call `onMessage(handleIncomingMessage)`.
 */

import { MessageContext } from '../core/MessageContext';

/** Implemented by every messaging-platform adapter (WhatsApp, Discord, etc.). */
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
