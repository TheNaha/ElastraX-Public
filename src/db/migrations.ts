import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../config/database.js';

export interface MigrationJournalEntry {
  tag: string;
  when: number;
  breakpoints: boolean;
}

export interface AppliedMigration {
  id: number;
  hash: string;
  createdAt: number;
}

export interface MigrationState {
  applied: AppliedMigration[];
  latestCreatedAt: number | null;
  pending: MigrationJournalEntry[];
  fingerprint: string | null;
}

const LEGACY_MIGRATION_HASHES = new Map<number, Set<string>>([
  [7, new Set(['84b40bcf66aa0c826f82253174f26177e1d3ba883c00a05d630f5fe8b845606d'])],
]);

const FINGERPRINT_IGNORED_TABLES = new Set([
  '__drizzle_migrations',
  'database_leases',
  'db_schema_meta',
]);

const REQUIRED_TABLES = [
  'app_kv',
  'canonical_identities',
  'chat_rooms',
  'database_leases',
  'db_schema_meta',
  'flow_sessions',
  'identity_aliases',
  'message_inbox',
  'message_outbox',
  'memories',
  'messages',
  'notification_subscriptions',
  'reminders',
  'role_privileges',
  'scheduled_deliveries',
  'service_bindings',
  'user_identities',
  'user_roles',
  'wa_auth_state',
];

const REQUIRED_INDEXES = [
  'canonical_identities_platform_primary_idx',
  'chat_rooms_platform_idx',
  'flow_sessions_updated_idx',
  'identity_aliases_canonical_idx',
  'identity_aliases_platform_alias_unique_idx',
  'message_inbox_platform_event_unique_idx',
  'message_inbox_platform_provider_unique_idx',
  'message_inbox_work_idx',
  'message_outbox_platform_idempotency_unique_idx',
  'message_outbox_platform_provider_unique_idx',
  'message_outbox_work_idx',
  'memories_owner_idx',
  'messages_chat_room_id_created_at_idx',
  'messages_chat_room_id_idx',
  'messages_platform_provider_message_id_unique',
  'reminders_due_idx',
  'reminders_remind_at_idx',
  'reminders_sender_id_idx',
  'scheduled_deliveries_platform_job_unique_idx',
  'scheduled_deliveries_platform_provider_unique_idx',
  'scheduled_deliveries_room_idx',
  'scheduled_deliveries_work_idx',
  'notification_subs_service_idx',
  'notification_subs_user_room_idx',
  'service_bindings_email_idx',
  'service_bindings_external_idx',
  'service_bindings_user_service_idx',
  'service_bindings_username_idx',
  'user_identities_canonical_idx',
  'user_identities_platform_lid_unique_idx',
  'user_identities_platform_pn_unique_idx',
  'user_roles_platform_user_scope_unique_idx',
  'user_roles_scope_idx',
];

const REQUIRED_COLUMNS: Record<string, string[]> = {
  messages: ['platform', 'provider_message_id'],
  reminders: ['claimed_at', 'language', 'remind_at', 'sender_id'],
  user_identities: ['canonical_id', 'lid', 'platform', 'pn'],
  user_roles: ['platform', 'scope', 'user_id'],
};

export function getMigrationsFolder(projectRoot: string = getProjectRoot()): string {
  return join(projectRoot, 'drizzle/migrations');
}

export function readMigrationJournal(migrationsFolder: string): MigrationJournalEntry[] {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as { entries?: MigrationJournalEntry[] };

  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error('Database migration journal is empty or invalid');
  }

  const seenTags = new Set<string>();
  const seenTimes = new Set<number>();
  for (const entry of journal.entries) {
    if (!entry.tag || seenTags.has(entry.tag)) throw new Error(`Duplicate migration tag: ${entry.tag}`);
    if (!Number.isSafeInteger(entry.when) || seenTimes.has(entry.when)) {
      throw new Error(`Invalid or duplicate migration timestamp: ${entry.when}`);
    }
    seenTags.add(entry.tag);
    seenTimes.add(entry.when);
  }

  return [...journal.entries].sort((a, b) => a.when - b.when);
}

function migrationHash(tag: string, migrationsFolder: string): string {
  return createHash('sha256')
    .update(readFileSync(join(migrationsFolder, `${tag}.sql`)))
    .digest('hex');
}

function tableExists(sqlite: Database, table: string): boolean {
  const row = sqlite
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(table);
  return row !== null;
}

function tableColumns(sqlite: Database, table: string): Set<string> {
  if (!tableExists(sqlite, table)) return new Set();
  const rows = sqlite
    .query<{ name: string }, [string]>(`SELECT name FROM pragma_table_xinfo(?) ORDER BY cid`)
    .all(table) as Array<{ name: string }>;
  return new Set(rows.map(row => row.name));
}

function appliedMigrations(sqlite: Database): AppliedMigration[] {
  if (!tableExists(sqlite, '__drizzle_migrations')) return [];
  const rows = sqlite
    .query<{ id: number; hash: string; created_at: number }, []>(
      'SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY created_at, id',
    )
    .all();
  return rows.map(row => ({
    id: Number(row.id),
    hash: String(row.hash),
    createdAt: Number(row.created_at),
  }));
}

function validateAppliedHashes(
  state: MigrationState,
  entries: MigrationJournalEntry[],
  migrationsFolder: string,
): void {
  for (let index = 0; index < state.applied.length; index++) {
    const applied = state.applied[index]!;
    const entry = entries[index];
    if (!entry) {
      throw new Error(`Unknown or future migration record at ${applied.createdAt}`);
    }

    const currentHash = migrationHash(entry.tag, migrationsFolder);
    const acceptedLegacyHashes = LEGACY_MIGRATION_HASHES.get(index);
    if (applied.hash !== currentHash && !acceptedLegacyHashes?.has(applied.hash)) {
      throw new Error(`Applied migration ${entry.tag} has an unexpected checksum`);
    }
  }
}

function validateKnownUpgradeState(sqlite: Database, state: MigrationState): void {
  const appliedCount = state.applied.length;
  if (appliedCount === 0) {
    const applicationTables = sqlite
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('database_leases')",
      )
      .all();
    if (applicationTables.length > 0) {
      throw new Error('Schema exists without a Drizzle migration ledger; refusing unsafe automatic adoption');
    }
    return;
  }

  if (appliedCount === 7) {
    const columns = tableColumns(sqlite, 'chat_rooms');
    if (!columns.has('temperature') || columns.has('max_tokens')) {
      throw new Error('Migration 0007 preflight failed: chat_rooms has an unexpected shape');
    }
  }

  if (appliedCount >= 8) {
    const columns = tableColumns(sqlite, 'chat_rooms');
    if (!columns.has('max_tokens')) {
      throw new Error('Migration 0008 is recorded as applied but chat_rooms.max_tokens is missing');
    }
  }

  if (appliedCount >= 19 && !tableColumns(sqlite, 'reminders').has('language')) {
    throw new Error('Migration 0019 is recorded as applied but reminders.language is missing');
  }
  if (appliedCount === 19 && tableColumns(sqlite, 'reminders').has('language')) {
    throw new Error('Migration 0019 is unapplied but reminders.language already exists; explicit adoption is required');
  }
}

export function inspectMigrationState(
  sqlite: Database,
  migrationsFolder: string = getMigrationsFolder(),
): MigrationState {
  const entries = readMigrationJournal(migrationsFolder);
  const applied = appliedMigrations(sqlite);
  const appliedTimes = new Set(entries.slice(0, applied.length).map(entry => entry.when));

  for (let index = 0; index < applied.length; index++) {
    const row = applied[index]!;
    const expected = entries[index];
    if (!expected || row.createdAt !== expected.when) {
      throw new Error(`Migration ledger has a gap or unknown record at position ${index + 1}`);
    }
  }
  if (appliedTimes.size !== applied.length) {
    throw new Error('Migration ledger contains duplicate timestamps');
  }

  const state: MigrationState = {
    applied,
    latestCreatedAt: applied.at(-1)?.createdAt ?? null,
    pending: entries.slice(applied.length),
    fingerprint: null,
  };
  validateAppliedHashes(state, entries, migrationsFolder);
  validateKnownUpgradeState(sqlite, state);
  return state;
}

function normalizeSchemaEntry(sqlite: Database, type: string, name: string, tableName: string, sqlDefinition: string | null): unknown {
  if (type !== 'table') return { type, name, tableName, sqlDefinition };
  return {
    type,
    name,
    tableName,
    sqlDefinition,
    columns: sqlite
      .query<Record<string, unknown>, [string]>(
        'SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)',
      )
      .all(name),
    foreignKeys: sqlite
      .query<Record<string, unknown>, [string]>(
        'SELECT id, seq, "table", "from", "to", on_update, on_delete, match FROM pragma_foreign_key_list(?) ORDER BY id, seq',
      )
      .all(name),
    indexes: sqlite
      .query<Record<string, unknown>, [string]>(
        'SELECT seq, name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY seq',
      )
      .all(name)
      .map(index => ({
        ...index,
        columns: sqlite
          .query<Record<string, unknown>, [string]>(
            'SELECT seqno, cid, name FROM pragma_index_info(?) ORDER BY seqno',
          )
          .all(String(index.name)),
      })),
  };
}

export function fingerprintSchema(sqlite: Database): string {
  const rows = sqlite
    .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('__drizzle_migrations', 'database_leases', 'db_schema_meta') ORDER BY type, name",
    )
    .all()
    .filter(row => !FINGERPRINT_IGNORED_TABLES.has(row.name))
    .map(row => normalizeSchemaEntry(sqlite, row.type, row.name, row.tbl_name, row.sql));

  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function validateSchemaContract(sqlite: Database): void {
  const missingTables = REQUIRED_TABLES.filter(table => !tableExists(sqlite, table));
  if (missingTables.length > 0) {
    throw new Error(`Database schema is missing required tables: ${missingTables.join(', ')}`);
  }

  const indexes = new Set(
    (sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()).map(row => row.name),
  );
  const missingIndexes = REQUIRED_INDEXES.filter(index => !indexes.has(index));
  if (missingIndexes.length > 0) {
    throw new Error(`Database schema is missing required indexes: ${missingIndexes.join(', ')}`);
  }

  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = tableColumns(sqlite, table);
    const missing = columns.filter(column => !actual.has(column));
    if (missing.length > 0) {
      throw new Error(`Database table ${table} is missing required columns: ${missing.join(', ')}`);
    }
  }

  const violations = sqlite
    .query<Record<string, unknown>, []>('PRAGMA foreign_key_check')
    .all();
  if (violations.length > 0) {
    throw new Error(`Database foreign-key validation failed with ${violations.length} violation(s)`);
  }
}

export function verifyStoredSchemaFingerprint(sqlite: Database): string | null {
  if (!tableExists(sqlite, 'db_schema_meta')) return null;
  const row = sqlite
    .query<{ fingerprint: string }, []>('SELECT fingerprint FROM db_schema_meta WHERE id = 1')
    .get();
  if (!row) return null;
  const actual = fingerprintSchema(sqlite);
  if (actual !== row.fingerprint) {
    throw new Error(`Database schema fingerprint mismatch: expected ${row.fingerprint}, received ${actual}`);
  }
  return actual;
}

export function recordSchemaFingerprint(
  sqlite: Database,
  schemaVersion: number,
  migrationCount: number,
  now: number = Date.now(),
): string {
  const fingerprint = fingerprintSchema(sqlite);
  sqlite
    .query<never, [number, string, number, number]>(
      `INSERT INTO db_schema_meta (id, schema_version, fingerprint, migration_count, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         schema_version = excluded.schema_version,
         fingerprint = excluded.fingerprint,
         migration_count = excluded.migration_count,
         updated_at = excluded.updated_at`,
    )
    .run(schemaVersion, fingerprint, migrationCount, now);
  return fingerprint;
}

export function assertDatabaseIntegrity(sqlite: Database): void {
  const result = sqlite.query<{ quick_check: string }, []>('PRAGMA quick_check').all();
  if (result.length !== 1 || result[0]?.quick_check !== 'ok') {
    throw new Error('SQLite quick_check failed');
  }
}
