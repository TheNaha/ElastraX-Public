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

import { sqliteTable, text, integer, real, index, uniqueIndex, blob } from 'drizzle-orm/sqlite-core';

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
  /** V7.13: Per-room summarization toggle. null = inherit CONTEXT_SUMMARIZE env (default: true). */
  summarize: integer('summarize', { mode: 'boolean' }),
  /** V7.16: Long-Term Memory (RAG) toggle. null = default (enabled for private, disabled for groups) */
  longTermMemory: integer('long_term_memory', { mode: 'boolean' }),
  
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  platformIdx: index('chat_rooms_platform_idx').on(table.platform),
}));

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

// V7.16: Long-Term Memory (RAG)
export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(), // uuid
  /** The chat room or user ID this memory belongs to */
  ownerId: text('owner_id').notNull(),
  /** The actual memory content/fact */
  content: text('content').notNull(),
  /** Optional tags for grouping */
  category: text('category'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  /** V8: Float32Array bytes from the embeddings API (null = not yet embedded) */
  embedding: blob('embedding', { mode: 'buffer' }),
  /** Model that produced `embedding` — vectors are only comparable within one model */
  embeddingModel: text('embedding_model'),
  /** When the vector was computed */
  embeddedAt: integer('embedded_at', { mode: 'timestamp' }),
}, (table) => ({
  ownerIdx: index('memories_owner_idx').on(table.ownerId),
}));

export type Memory = typeof memories.$inferSelect;

// V8: Generic key/value store for exactly-once scheduled-job markers
// (daily digest / weekly media digest last-run dates, future feature flags).
export const appKv = sqliteTable('app_kv', {
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type AppKvRow = typeof appKv.$inferSelect;

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
  // Claim marker for at-most-once delivery across restarts/concurrent workers (null = unclaimed)
  claimedAt: integer('claimed_at', { mode: 'timestamp' }),
  // Which platform this reminder belongs to
  platform: text('platform').notNull().default('whatsapp'),
  /** Cron-style recurrence pattern (e.g. 'daily', 'weekly', 'monthly', or cron expression). Null = one-shot. */
  recurrence: text('recurrence'),
  /** V8: Language code used when firing this reminder, so messages respect room language. */
  language: text('language').notNull().default('en'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  remindAtIdx: index('reminders_remind_at_idx').on(table.remindAt, table.isSent),
  senderIdIdx: index('reminders_sender_id_idx').on(table.senderId),
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
  // UNIQUE(user_id, scope): one role per user per scope (migration 0007).
  // AuthService.setRole relies on replace-on-conflict semantics.
  userScopeIdx: uniqueIndex('user_roles_user_scope_idx').on(table.userId, table.scope),
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

// V7.12: User identity mapping (LID ↔ PN ↔ display name)
// Persists the Baileys V7 LID-to-phone-number mapping in our own DB so that
// role lookups, owner checks, and /role check can resolve all JIDs for a user
// even when the Baileys signal store doesn't have the mapping yet.
export const userIdentities = sqliteTable('user_identities', {
  /** LID JID (e.g. "265841933336713@lid") — the canonical Baileys V7 identifier. */
  lid: text('lid'),
  /** Phone-number JID (e.g. "6281234567890@s.whatsapp.net"). */
  pn: text('pn'),
  /** Platform — always 'whatsapp' for now but could extend to 'discord'. */
  platform: text('platform').notNull().default('whatsapp'),
  /** Last known display name (pushName). */
  displayName: text('display_name'),
  /** When this record was last seen / updated. */
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  /** One identity row per LID / PN (canonical *_unique_idx names from migration 0013). */
  lidIdx: uniqueIndex('user_identities_lid_unique_idx').on(table.lid),
  pnIdx: uniqueIndex('user_identities_pn_unique_idx').on(table.pn),
}));

export type UserIdentity = typeof userIdentities.$inferSelect;

// V7.15: Extensible external service account bindings (Jellyfin, Seerr, etc.)
export const serviceBindings = sqliteTable('service_bindings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Bot user ID (WA JID or Discord ID). */
  userId: text('user_id').notNull(),
  /** 'whatsapp' | 'discord' */
  platform: text('platform').notNull(),
  /** 'jellyfin' | 'seerr' | extensible */
  serviceType: text('service_type').notNull(),
  /** External service user ID (e.g. Jellyfin userId, Seerr userId). */
  externalUserId: text('external_user_id').notNull(),
  /** External username (for webhook matching). */
  externalUsername: text('external_username').notNull(),
  /** External email (for webhook matching by email). */
  externalEmail: text('external_email'),
  /** JSON blob for extra data (isAdmin flag, avatar, tokens, etc.). */
  metadata: text('metadata'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  userServiceIdx: uniqueIndex('service_bindings_user_service_idx').on(table.userId, table.platform, table.serviceType),
  externalIdx: index('service_bindings_external_idx').on(table.serviceType, table.externalUserId),
  emailIdx: index('service_bindings_email_idx').on(table.serviceType, table.externalEmail),
  usernameIdx: index('service_bindings_username_idx').on(table.serviceType, table.externalUsername),
}));

export type ServiceBinding = typeof serviceBindings.$inferSelect;

// V7.15: Notification routing — which rooms receive which service notifications
export const notificationSubscriptions = sqliteTable('notification_subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Bot user ID. */
  userId: text('user_id').notNull(),
  /** 'whatsapp' | 'discord' */
  platform: text('platform').notNull(),
  /** 'jellyfin' | 'seerr' | 'all' */
  serviceType: text('service_type').notNull(),
  /** Target chat room for notifications. */
  chatRoomId: text('chat_room_id').notNull(),
  /** JSON array of notification types to receive, null = all. */
  notifyTypes: text('notify_types'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  userRoomIdx: uniqueIndex('notification_subs_user_room_idx').on(table.userId, table.platform, table.serviceType, table.chatRoomId),
  serviceIdx: index('notification_subs_service_idx').on(table.serviceType),
}));

export type NotificationSubscription = typeof notificationSubscriptions.$inferSelect;
