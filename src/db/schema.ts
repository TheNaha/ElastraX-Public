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

// V7.8: Persistent Reminder/Scheduler entries
export const reminders = sqliteTable('reminders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatRoomId: text('chat_room_id')
    .notNull()
    .references(() => chatRooms.id),
  // The user who set the reminder (JID or Discord userId)
  senderId: text('sender_id').notNull(),
  senderName: text('sender_name').notNull(),
  // Human-readable reminder message
  message: text('message').notNull(),
  // Unix timestamp (ms) when the reminder fires
  remindAt: integer('remind_at', { mode: 'timestamp' }).notNull(),
  // Whether the reminder has already been delivered
  isSent: integer('is_sent', { mode: 'boolean' }).default(false).notNull(),
  // Which platform this reminder belongs to
  platform: text('platform').notNull().default('whatsapp'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  remindAtIdx: index('reminders_remind_at_idx').on(table.remindAt, table.isSent),
}));

export type Reminder = typeof reminders.$inferSelect;

// V7.9: User permission / role management
export const userRoles = sqliteTable('user_roles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  platform: text('platform').notNull().default('whatsapp'),
  /** 'global' or a specific chatId */
  scope: text('scope').notNull().default('global'),
  role: text('role').notNull().default('user'), // 'user' | 'admin' | 'owner'
  grantedBy: text('granted_by').notNull(),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  userScopeIdx: index('user_roles_user_scope_idx').on(table.userId, table.scope),
  scopeIdx: index('user_roles_scope_idx').on(table.scope, table.role),
}));

export type UserRole = typeof userRoles.$inferSelect;
