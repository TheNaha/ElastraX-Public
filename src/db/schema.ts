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
  temperature: real('temperature'),
  maxTokens: integer('max_tokens'),
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
  /** Cron-style recurrence pattern (e.g. 'daily', 'weekly', 'monthly', or cron expression). Null = one-shot. */
  recurrence: text('recurrence'),
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

// V7.11: Per-role privilege quotas (env defaults + DB overrides)
export const rolePrivileges = sqliteTable('role_privileges', {
  /** Role name: 'user', 'premium', 'admin', 'owner', or any custom role */
  role: text('role').primaryKey(),
  /** Max messages allowed per rate-limit window. -1 = unlimited. */
  maxMessagesPerWindow: integer('max_messages_per_window'),
  /** Rate-limit window duration in seconds. */
  rateLimitWindowSec: integer('rate_limit_window_sec'),
  /** Max conversation context messages sent to the LLM. */
  contextLimit: integer('context_limit'),
  /** Max download file size in MB. -1 = unlimited. */
  maxDownloadMb: integer('max_download_mb'),
});

export type RolePrivilege = typeof rolePrivileges.$inferSelect;

// V7.10: Persistent flow session state (survives container restarts)
export const flowSessions = sqliteTable('flow_sessions', {
  /** Composite key "platform:userId" */
  id: text('id').primaryKey(),
  /** JSON serialized UserSession data */
  data: text('data').notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  updatedIdx: index('flow_sessions_updated_idx').on(table.updated_at),
}));

export type FlowSessionRow = typeof flowSessions.$inferSelect;
