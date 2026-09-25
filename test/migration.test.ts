/**
 * test/migration.test.ts
 *
 * Verifies that Drizzle migrations apply cleanly on a fresh in-memory database
 * and that the _journal.json stays in sync with the migration files on disk.
 */

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { join } from 'node:path';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test, describe, expect, beforeEach, afterEach } from 'bun:test';
import * as schema from '../src/db/schema';
import { inspectMigrationState } from '../src/db/migrations';
import { ROOT_DIR } from '../src/core/constants';

describe('Database Migrations', () => {
  describe('ensureDatabaseSchema (fresh in-memory DB)', () => {
    // This tests the actual migration path used at runtime
    let sqlite: Database;
    let db: ReturnType<typeof drizzle<typeof schema>>;

    beforeEach(() => {
      sqlite = new Database(':memory:');
      sqlite.exec('PRAGMA foreign_keys = ON;');
      db = drizzle({ client: sqlite, schema });
    });

    afterEach(() => {
      sqlite.close();
    });

    test('migrations apply without error on fresh DB', async () => {
      await migrate(db, { migrationsFolder: join(ROOT_DIR, 'drizzle/migrations') });

      // Verify the reminders table has the language column (migration 0019)
      const cols = sqlite.prepare('PRAGMA table_info(reminders)').all() as Array<{ name: string }>;
      const colNames = cols.map(c => c.name);
      expect(colNames).toContain('language');
      expect(colNames).toContain('recurrence');
      expect(colNames).toContain('claimed_at');
      expect(inspectMigrationState(sqlite, join(ROOT_DIR, 'drizzle/migrations')).pending).toHaveLength(0);
      sqlite.exec("UPDATE __drizzle_migrations SET hash = '84b40bcf66aa0c826f82253174f26177e1d3ba883c00a05d630f5fe8b845606d' WHERE created_at = 8");
      expect(inspectMigrationState(sqlite, join(ROOT_DIR, 'drizzle/migrations')).pending).toHaveLength(0);
    });

    test('all migration files have corresponding journal entries', () => {
      const migrationsDir = join(ROOT_DIR, 'drizzle/migrations');
      const journalPath = join(migrationsDir, 'meta/_journal.json');
      const migrationFiles = readdirSync(migrationsDir)
        .filter(f => /^\d{4}_.+\.sql$/.test(f))
        .map(f => f.replace(/\.sql$/, ''));
      const journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
      const journalTags = new Set<string>(journal.entries.map((entry: { tag: string }) => entry.tag));

      for (const file of migrationFiles) {
        expect(journalTags.has(file)).toBe(true);
      }
    });

    test('preflight refuses to adopt a schema created without the migration ledger', () => {
      sqlite.exec('CREATE TABLE app_kv (id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
      expect(() => inspectMigrationState(sqlite, join(ROOT_DIR, 'drizzle/migrations'))).toThrow('refusing unsafe automatic adoption');
    });

    test('upgrades a populated migration-0007 database without losing child rows', async () => {
      const migrationsDir = join(ROOT_DIR, 'drizzle/migrations');
      const partialDir = mkdtempSync(join(tmpdir(), 'elastrax-migrations-0007-'));
      const partialMeta = join(partialDir, 'meta');
      mkdirSync(partialMeta);
      try {
        const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8'));
        const partialJournal = { ...journal, entries: journal.entries.slice(0, 8) };
        writeFileSync(join(partialMeta, '_journal.json'), JSON.stringify(partialJournal));
        for (const entry of partialJournal.entries) {
          cpSync(join(migrationsDir, `${entry.tag}.sql`), join(partialDir, `${entry.tag}.sql`));
        }

        migrate(db, { migrationsFolder: partialDir });
        sqlite.exec(`
          INSERT INTO chat_rooms (id, platform, language, temperature, created_at)
          VALUES ('room-0007', 'whatsapp', 'en', 0.6, 1000);
          INSERT INTO messages (chat_room_id, provider_message_id, sender_id, sender_name, role, content, created_at)
          VALUES ('room-0007', 'provider-0007', 'sender', 'Sender', 'user', 'survives', 1001);
          INSERT INTO reminders (chat_room_id, sender_id, sender_name, message, remind_at, is_sent, platform, created_at)
          VALUES ('room-0007', 'sender', 'Sender', 'survives', 2000, 0, 'whatsapp', 1002);
        `);

        migrate(db, { migrationsFolder: migrationsDir });

        expect(sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM messages').get()?.count).toBe(1);
        expect(sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM reminders').get()?.count).toBe(1);
        expect(sqlite.query<{ type: string }, []>("SELECT type FROM pragma_table_info('chat_rooms') WHERE name = 'temperature'").get()?.type).toBe('REAL');
        expect(sqlite.query('PRAGMA foreign_key_check').all()).toHaveLength(0);
      } finally {
        rmSync(partialDir, { recursive: true, force: true });
      }
    });

    test('0019 and forward snapshot metadata form a complete chain', () => {
      const metaDir = join(ROOT_DIR, 'drizzle/migrations/meta');
      const snapshot0018 = JSON.parse(readFileSync(join(metaDir, '0018_snapshot.json'), 'utf8'));
      const snapshot0019 = JSON.parse(readFileSync(join(metaDir, '0019_snapshot.json'), 'utf8'));
      const snapshot0020 = JSON.parse(readFileSync(join(metaDir, '0020_snapshot.json'), 'utf8'));
      const snapshot0021 = JSON.parse(readFileSync(join(metaDir, '0021_snapshot.json'), 'utf8'));

      expect(snapshot0019.prevId).toBe(snapshot0018.id);
      expect(snapshot0019.tables.reminders.columns.language.default).toBe("'en'");
      expect(snapshot0020.prevId).toBe(snapshot0019.id);
      expect(snapshot0021.prevId).toBe(snapshot0020.id);
      expect(snapshot0021.tables.message_inbox).toBeDefined();
      expect(snapshot0021.tables.scheduled_deliveries).toBeDefined();
    });
  });
});
