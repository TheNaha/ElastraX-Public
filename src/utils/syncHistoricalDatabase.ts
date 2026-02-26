/**
 * @file src/utils/syncHistoricalDatabase.ts
 * @description Bulk ingestion of Baileys history-sync messages into the ElastraX database.
 *
 * When a new WhatsApp session is established (or when Baileys reconnects), WhatsApp
 * may push a `messaging-history.set` event containing messages that were sent/received
 * before the bot's current session started.  This module persists those historical
 * messages so that the LLM context window contains real prior conversation history
 * rather than starting blank.
 *
 * Design principles:
 *  - **Idempotent**: uses `onConflictDoNothing()` keyed on `providerMessageId` so
 *    running the sync multiple times on the same data is safe.
 *  - **Non-blocking**: called via `.catch()` in the provider so failures here
 *    never crash the main bot process.
 *  - **Media-light**: historical messages are stored without downloading their
 *    media attachments to avoid hammering the WhatsApp CDN at startup.
 */

import { db } from '../db';
import { chatRooms, messages } from '../db/schema';
import { logger } from './logger';
import { MessageContext } from '../core/MessageContext';

/**
 * Syncs an array of historical messages into the database.
 * This function is designed to be idempotent; if a message with the same
 * providerMessageId already exists, it will be ignored (onConflictDoNothing).
 */
export async function syncHistoricalDatabase(historicalMessages: MessageContext[]): Promise<void> {
  if (historicalMessages.length === 0) return;

  logger.info(`[History Sync] Starting bulk ingestion of ${historicalMessages.length} historical messages...`);

  let count = 0;
  
  // We can't guarantee all chat rooms already exist, so we track them lightly
  const knownRooms = new Set<string>();

  for (const ctx of historicalMessages) {
    try {
      // 1. Ensure the room exists first
      if (!knownRooms.has(ctx.chatId)) {
        await db.insert(chatRooms)
          .values({
            id: ctx.chatId,
            platform: ctx.platform,
            language: 'en', // Default language for historical rooms
            created_at: new Date(),
          })
          .onConflictDoNothing();
        knownRooms.add(ctx.chatId);
      }

      // 2. Insert the message idempotently
      // For historical syncs, we assume these are 'user' role messages or group members.
      // We don't try to sync bot's own past messages currently unless we explicitly checking fromMe.
      // Usually Baileys history sync includes fromMe. If fromMe is true, role could be 'assistant'.
      
      const isFromMe = (ctx.rawMessage as any)?.key?.fromMe;
      
      await db.insert(messages)
        .values({
          chatRoomId: ctx.chatId,
          providerMessageId: ctx.messageId,
          senderId: ctx.senderId,
          senderName: ctx.senderName,
          role: isFromMe ? 'assistant' : 'user',
          content: ctx.text,
          rawMessage: JSON.stringify(ctx.rawMessage),
          // We don't historically mass-download media right now as that would hammer the network
          // We just leave mediaPath null for historical messages until natively requested
          // We can record the mime type though.
          mimeType: Array.from(ctx.text).length > 0 ? undefined : 'application/octet-stream', // heuristic
          created_at: new Date(((ctx.rawMessage as any)?.messageTimestamp || Date.now() / 1000) * 1000), 
        })
        .onConflictDoNothing();
        
      count++;
    } catch (err) {
      logger.error({ err, messageId: ctx.messageId }, 'Failed to sync historical message');
    }
  }

  logger.info(`[History Sync] Completed logic loop. Attempted to insert ${count} messages natively.`);
}
