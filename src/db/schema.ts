/**
 * @file src/db/schema.ts
 * @description Drizzle ORM table definitions for the ElastraX SQLite database.
 *
 * Tables:
 *  - `chat_rooms`   — One row per unique chat/group across all platforms.
 *                     Stores per-room configuration overrides (V7.5+).
 *  - `room_keys`    — Canonical room identity registry. Room keys are deterministic
 *                     `room:<platform>:<remoteRoomId>` strings (V8.1, migration 0022).
 *                     Legacy `chat_room_id` columns are retained for rollback.
 *  - `messages`     — Append-only log of every user and assistant message.
 *                     Serves as the conversation history window sent to the LLM.
 *  - `wa_auth_state`— Key-value store for Baileys WhatsApp authentication credentials.
 *                     Replaces the file-system auth_info_baileys/ folder so credentials
 *                     survive container restarts without a mounted volume.
 *
 * Migration files live in `drizzle/migrations/` and are applied automatically on startup
 * via `drizzle-kit` in `src/index.ts`.
 */

import { sqliteTable, text, integer, real, index, uniqueIndex, blob, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const chatRooms = sqliteTable('chat_rooms', {
  id: text('id').primaryKey(), // Legacy remote JID/ID, or the canonical room key for new V8.1 rooms
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
  /** V8.1: Canonical room identity (`room:<platform>:<id>`). Null until backfilled by migration 0022. */
  roomKey: text('room_key'),
}, (table) => ({
  platformIdx: index('chat_rooms_platform_idx').on(table.platform),
  roomKeyIdx: index('chat_rooms_room_key_idx').on(table.roomKey),
  // One room row per canonical key. NULL/empty keys stay allowed so a pre-migration
  // or unresolved row can be recorded without a placeholder identity.
  roomKeyUniqueIdx: uniqueIndex('chat_rooms_room_key_unique_idx')
    .on(table.roomKey)
    .where(sql`${table.roomKey} is not null and ${table.roomKey} <> ''`),
}));

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatRoomId: text('chat_room_id')
    .notNull()
    .references(() => chatRooms.id),
  platform: text('platform'),
  providerMessageId: text('provider_message_id'),
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
  /** V8.1: Canonical room identity copied from `chat_rooms.room_key`. Null = not backfilled yet. */
  roomKey: text('room_key'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  chatRoomIdIdx: index('messages_chat_room_id_idx').on(table.chatRoomId),
  chatRoomIdCreatedAtIdx: index('messages_chat_room_id_created_at_idx').on(table.chatRoomId, table.created_at),
  roomKeyCreatedAtIdx: index('messages_room_key_created_at_idx').on(table.roomKey, table.created_at),
  providerMessageIdx: uniqueIndex('messages_platform_provider_message_id_unique').on(
    table.platform,
    table.chatRoomId,
    table.providerMessageId,
  ).where(sql`${table.providerMessageId} is not null and lower(trim(${table.providerMessageId})) not in ('', 'unknown', 'null')`),
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
  /** V8.1: Canonical room identity copied from `chat_rooms.room_key`. Null = not backfilled yet. */
  roomKey: text('room_key'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  remindAtIdx: index('reminders_remind_at_idx').on(table.remindAt, table.isSent),
  dueReminderIdx: index('reminders_due_idx').on(table.isSent, table.remindAt, table.claimedAt),
  senderIdIdx: index('reminders_sender_id_idx').on(table.senderId, table.isSent, table.remindAt),
  roomKeyIdx: index('reminders_room_key_idx').on(table.roomKey, table.isSent, table.remindAt),
}));

export type Reminder = typeof reminders.$inferSelect;

// V7.9: User permission / role management
export const userRoles = sqliteTable('user_roles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  platform: text('platform').notNull().default('whatsapp'),
  /** 'global' or a specific chatId */
  scope: text('scope').notNull().default('global'),
  /** V8.1: Canonical room identity for room-scoped rows. Null for `scope = 'global'` and unresolved scopes. */
  scopeRoomKey: text('scope_room_key'),
  role: text('role').notNull().default('user'), // 'user' | 'admin' | 'owner'
  grantedBy: text('granted_by').notNull(),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  userScopeIdx: uniqueIndex('user_roles_platform_user_scope_unique_idx').on(table.platform, table.userId, table.scope),
  scopeIdx: index('user_roles_scope_idx').on(table.scope, table.role),
  scopeRoomKeyIdx: index('user_roles_scope_room_key_idx').on(table.scopeRoomKey, table.role),
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
  /** V8.1: Canonical room identity. Null for user-scoped sessions; set once a flow is bound to a room. */
  roomKey: text('room_key'),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  updatedIdx: index('flow_sessions_updated_idx').on(table.updated_at),
  roomKeyIdx: index('flow_sessions_room_key_idx').on(table.roomKey, table.updated_at),
}));

export type FlowSessionRow = typeof flowSessions.$inferSelect;

// V7.12: User identity mapping (LID ↔ PN ↔ display name)
// Persists the Baileys V7 LID-to-phone-number mapping in our own DB so that
// role lookups, owner checks, and /role check can resolve all JIDs for a user
// even when the Baileys signal store doesn't have the mapping yet.
export const userIdentities = sqliteTable('user_identities', {
  canonicalId: text('canonical_id'),
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
  lidIdx: uniqueIndex('user_identities_platform_lid_unique_idx').on(table.platform, table.lid),
  pnIdx: uniqueIndex('user_identities_platform_pn_unique_idx').on(table.platform, table.pn),
  canonicalIdx: index('user_identities_canonical_idx').on(table.platform, table.canonicalId),
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
  /** V8.1: Canonical room identity copied from `chat_rooms.room_key`. Null = not backfilled yet. */
  roomKey: text('room_key'),
  /** JSON array of notification types to receive, null = all. */
  notifyTypes: text('notify_types'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  userRoomIdx: uniqueIndex('notification_subs_user_room_idx').on(table.userId, table.platform, table.serviceType, table.chatRoomId),
  serviceIdx: index('notification_subs_service_idx').on(table.serviceType),
  roomKeyIdx: index('notification_subs_room_key_idx').on(table.roomKey),
  // The same subscription target may not resolve to two canonical room keys, so
  // duplicate deliveries after a room alias are impossible once keys are present.
  roomKeyUniqueIdx: uniqueIndex('notification_subs_room_key_unique_idx')
    .on(table.userId, table.platform, table.serviceType, table.roomKey)
    .where(sql`${table.roomKey} is not null and ${table.roomKey} <> ''`),
}));

export type NotificationSubscription = typeof notificationSubscriptions.$inferSelect;

export const canonicalIdentities = sqliteTable('canonical_identities', {
  id: text('id').primaryKey(),
  platform: text('platform').notNull(),
  primaryAlias: text('primary_alias').notNull(),
  displayName: text('display_name'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
}, (table) => ({
  platformPrimaryIdx: uniqueIndex('canonical_identities_platform_primary_idx').on(table.platform, table.primaryAlias),
  platformUpdatedIdx: index('canonical_identities_platform_updated_idx').on(table.platform, table.updated_at),
}));

export const identityAliases = sqliteTable('identity_aliases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  canonicalId: text('canonical_id').notNull().references(() => canonicalIdentities.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  alias: text('alias').notNull(),
  aliasKind: text('alias_kind').notNull(),
  metadata: text('metadata'),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
}, (table) => ({
  platformAliasIdx: uniqueIndex('identity_aliases_platform_alias_unique_idx').on(table.platform, table.alias),
  canonicalIdx: index('identity_aliases_canonical_idx').on(table.canonicalId, table.lastSeenAt),
}));

export type CanonicalIdentity = typeof canonicalIdentities.$inferSelect;
export type IdentityAlias = typeof identityAliases.$inferSelect;

export const messageInbox = sqliteTable('message_inbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  platform: text('platform').notNull(),
  chatRoomId: text('chat_room_id').notNull(),
  /** V8.1: Canonical room identity (`room:<platform>:<chat_room_id>`). Null = not backfilled yet. */
  roomKey: text('room_key'),
  providerMessageId: text('provider_message_id'),
  eventKey: text('event_key').notNull(),
  state: text('state', {
    enum: ['received', 'processing', 'completed', 'failed', 'dead_letter'],
  }).notNull().default('received'),
  payload: text('payload'),
  attemptCount: integer('attempt_count').notNull().default(0),
  availableAt: integer('available_at').notNull(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: integer('lease_expires_at'),
  lastError: text('last_error'),
  receivedAt: integer('received_at').notNull(),
  completedAt: integer('completed_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  platformEventIdx: uniqueIndex('message_inbox_platform_event_unique_idx').on(table.platform, table.eventKey),
  platformProviderIdx: uniqueIndex('message_inbox_platform_provider_unique_idx').on(
    table.platform,
    table.chatRoomId,
    table.providerMessageId,
  ).where(sql`${table.providerMessageId} is not null and lower(trim(${table.providerMessageId})) not in ('', 'unknown', 'null')`),
  workIdx: index('message_inbox_work_idx').on(table.state, table.availableAt, table.leaseExpiresAt),
  roomIdx: index('message_inbox_room_idx').on(table.platform, table.chatRoomId, table.receivedAt),
  roomKeyIdx: index('message_inbox_room_key_idx').on(table.roomKey, table.receivedAt),
}));

export type MessageInbox = typeof messageInbox.$inferSelect;

export const messageOutbox = sqliteTable('message_outbox', {
  id: text('id').primaryKey(),
  platform: text('platform').notNull(),
  chatRoomId: text('chat_room_id').notNull(),
  /** V8.1: Canonical room identity (`room:<platform>:<chat_room_id>`). Null = not backfilled yet. */
  roomKey: text('room_key'),
  idempotencyKey: text('idempotency_key').notNull(),
  providerMessageId: text('provider_message_id'),
  state: text('state', {
    enum: ['pending', 'leased', 'sent', 'failed', 'dead_letter'],
  }).notNull().default('pending'),
  payload: text('payload').notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  availableAt: integer('available_at').notNull(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: integer('lease_expires_at'),
  lastError: text('last_error'),
  sentAt: integer('sent_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  platformIdempotencyIdx: uniqueIndex('message_outbox_platform_idempotency_unique_idx').on(
    table.platform,
    table.idempotencyKey,
  ),
  platformProviderIdx: uniqueIndex('message_outbox_platform_provider_unique_idx').on(
    table.platform,
    table.chatRoomId,
    table.providerMessageId,
  ).where(sql`${table.providerMessageId} is not null and lower(trim(${table.providerMessageId})) not in ('', 'unknown', 'null')`),
  workIdx: index('message_outbox_work_idx').on(table.state, table.availableAt, table.leaseExpiresAt),
  roomKeyIdx: index('message_outbox_room_key_idx').on(table.roomKey, table.createdAt),
}));

export type MessageOutbox = typeof messageOutbox.$inferSelect;

export const scheduledDeliveries = sqliteTable('scheduled_deliveries', {
  id: text('id').primaryKey(),
  platform: text('platform').notNull(),
  jobKey: text('job_key').notNull(),
  chatRoomId: text('chat_room_id').notNull(),
  /** V8.1: Canonical room identity (`room:<platform>:<chat_room_id>`). Null = not backfilled yet. */
  roomKey: text('room_key'),
  providerMessageId: text('provider_message_id'),
  state: text('state', {
    enum: ['pending', 'leased', 'sent', 'failed', 'dead_letter'],
  }).notNull().default('pending'),
  payload: text('payload').notNull(),
  scheduledAt: integer('scheduled_at').notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  availableAt: integer('available_at').notNull(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: integer('lease_expires_at'),
  lastError: text('last_error'),
  sentAt: integer('sent_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  platformJobIdx: uniqueIndex('scheduled_deliveries_platform_job_unique_idx').on(table.platform, table.jobKey),
  platformProviderIdx: uniqueIndex('scheduled_deliveries_platform_provider_unique_idx').on(
    table.platform,
    table.chatRoomId,
    table.providerMessageId,
  ).where(sql`${table.providerMessageId} is not null and lower(trim(${table.providerMessageId})) not in ('', 'unknown', 'null')`),
  workIdx: index('scheduled_deliveries_work_idx').on(table.state, table.scheduledAt, table.availableAt, table.leaseExpiresAt),
  roomIdx: index('scheduled_deliveries_room_idx').on(table.platform, table.chatRoomId, table.scheduledAt),
  roomKeyIdx: index('scheduled_deliveries_room_key_idx').on(table.roomKey, table.scheduledAt),
}));

export type ScheduledDelivery = typeof scheduledDeliveries.$inferSelect;

export const databaseLeases = sqliteTable('database_leases', {
  name: text('name').primaryKey(),
  owner: text('owner').notNull(),
  expiresAt: integer('expires_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type DatabaseLease = typeof databaseLeases.$inferSelect;

// V8.1: Canonical room identity registry.
// A room key is a deterministic, transparent string — `room:<platform>:<remoteRoomId>` —
// so any stored key can be parsed back into the platform/remote-id pair without a lookup.
// The table records which legacy `chat_rooms.id` (when one exists) each key was derived from,
// which keeps the old columns usable for rollback.
export const roomKeys = sqliteTable('room_keys', {
  /** Canonical key: `room:<platform>:<remoteRoomId>`. */
  roomKey: text('room_key').primaryKey(),
  /** 'whatsapp' | 'discord' */
  platform: text('platform').notNull(),
  /** Provider-native room identifier (WhatsApp JID, Discord channel id). */
  remoteRoomId: text('remote_room_id').notNull(),
  /** Pre-V8.1 `chat_rooms.id` this key replaced, when the room already existed. */
  legacyRoomId: text('legacy_room_id'),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  platformRemoteIdx: uniqueIndex('room_keys_platform_remote_room_unique_idx').on(table.platform, table.remoteRoomId),
  platformLegacyIdx: uniqueIndex('room_keys_platform_legacy_room_unique_idx')
    .on(table.platform, table.legacyRoomId)
    .where(sql`${table.legacyRoomId} is not null and ${table.legacyRoomId} <> ''`),
  legacyIdx: index('room_keys_legacy_room_idx')
    .on(table.legacyRoomId)
    .where(sql`${table.legacyRoomId} is not null and ${table.legacyRoomId} <> ''`),
  platformCreatedIdx: index('room_keys_platform_created_idx').on(table.platform, table.createdAt),
}));

export type RoomKeyRow = typeof roomKeys.$inferSelect;
export type NewRoomKeyRow = typeof roomKeys.$inferInsert;

// V8.1: Migration audit trail for ambiguous or unresolved room identity.
// Rows are append-only evidence written by migration 0022 and by the read-only
// reporting script; they never gate runtime behaviour.
export const roomKeyConflicts = sqliteTable('room_key_conflicts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Deterministic identity of the finding so repeated audits stay idempotent. */
  fingerprint: text('fingerprint').notNull(),
  /** 'legacy_room_claimed' | 'room_key_not_transparent' | 'unresolved_scope' | ... */
  conflictType: text('conflict_type').notNull(),
  platform: text('platform').notNull().default(''),
  roomKey: text('room_key'),
  remoteRoomId: text('remote_room_id'),
  legacyRoomId: text('legacy_room_id'),
  /** Free-form human-readable context. */
  details: text('details'),
  /** Which component recorded the finding, e.g. `migration:0022_room_keys`. */
  detectedBy: text('detected_by').notNull().default('migration:0022_room_keys'),
  detectedAt: integer('detected_at').notNull(),
  resolvedAt: integer('resolved_at'),
  resolution: text('resolution'),
}, (table) => ({
  fingerprintIdx: uniqueIndex('room_key_conflicts_fingerprint_unique_idx').on(table.fingerprint),
  typeDetectedIdx: index('room_key_conflicts_type_detected_idx').on(table.conflictType, table.detectedAt),
  platformRemoteIdx: index('room_key_conflicts_platform_remote_idx').on(table.platform, table.remoteRoomId),
  unresolvedIdx: index('room_key_conflicts_unresolved_idx').on(table.conflictType, table.resolvedAt),
}));

export type RoomKeyConflict = typeof roomKeyConflicts.$inferSelect;
export type NewRoomKeyConflict = typeof roomKeyConflicts.$inferInsert;

export const dbSchemaMeta = sqliteTable('db_schema_meta', {
  id: integer('id').primaryKey(),
  schemaVersion: integer('schema_version').notNull(),
  fingerprint: text('fingerprint').notNull(),
  migrationCount: integer('migration_count').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  singletonCheck: check('db_schema_meta_singleton_check', sql`${table.id} = 1`),
}));

export type DbSchemaMeta = typeof dbSchemaMeta.$inferSelect;
