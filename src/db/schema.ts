/**
 * @file src/db/schema.ts
 * @description Drizzle ORM table definitions for the ElastraX SQLite database.
 *
 * Tables:
 *  - `chat_rooms`   — One row per unique chat/group across all platforms.
 *                     Stores per-room configuration overrides (V7.5+).
 *  - `messages`     — Append-only log of every user and assistant message.
 *                     Serves as the conversation history window sent to the LLM.
 *  - `wa_auth_state`— Key-value store for Baileys WhatsApp authentication credentials.
 *                     Replaces the file-system auth_info_baileys/ folder so credentials
 *                     survive container restarts without a mounted volume.
 *
 * Migration files live in `drizzle/migrations/` and are applied automatically on startup
 * via `drizzle-kit` in `src/index.ts`.
 */

import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

export const chatRooms = sqliteTable('chat_rooms', {
  id: text('id').primaryKey(), // The chat/group JID
  platform: text('platform').notNull(), // 'whatsapp' | 'discord'
  language: text('language').default('en').notNull(), // 'en' | 'id'
  
  // V7.5 Dynamic Configuration Overrides (nullable means fallback to .env)
  systemPrompt: text('system_prompt'), 
  contextLimit: integer('context_limit'),
  temperature: integer('temperature', { mode: 'number' }), // SQLite REAL requires integer/decimal mapping depending on driver, drizzle uses integer or real
  // actually drizzle has `real` type for floats
  allowTools: integer('allow_tools', { mode: 'boolean' }),
  autoReplyAll: integer('auto_reply_all', { mode: 'boolean' }),
  
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatRoomId: text('chat_room_id')
    .notNull()
    .references(() => chatRooms.id),
  providerMessageId: text('provider_message_id').unique(), // V7.4 for history sync deduplication
  senderId: text('sender_id').notNull(),
  senderName: text('sender_name').notNull(),
  role: text('role').notNull(), // 'user' | 'assistant'
  content: text('content').notNull(),
  rawMessage: text('raw_message'), // Store complete provider message JSON for historical media downloads
  toolCalls: text('tool_calls'), // JSON array of tool calls
  toolCallId: text('tool_call_id'),
  
  // V7.2: Advanced Media Management
  mediaPath: text('media_path'), // Local path like ./data/media/<uuid>.jpg
  mimeType: text('mime_type'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  chatRoomIdIdx: index('messages_chat_room_id_idx').on(table.chatRoomId),
  chatRoomIdCreatedAtIdx: index('messages_chat_room_id_created_at_idx').on(table.chatRoomId, table.created_at),
}));

export type ChatRoom = typeof chatRooms.$inferSelect;
export type Message = typeof messages.$inferSelect;

// V7.3: Database-backed Authentication State for WhatsApp (Baileys)
export const waAuthState = sqliteTable('wa_auth_state', {
  // Baileys keys like 'creds' or 'app-state-sync-key-XYZ'
  id: text('id').primaryKey(),
  // JSON serialized data directly stringified with Baileys' custom replacer
  data: text('data').notNull(),
});
