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
import { readdirSync, readFileSync } from 'node:fs';
import { test, describe, expect, beforeEach, afterEach } from 'bun:test';
import * as schema from '../src/db/schema';
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
      // This should not throw — all 20 migrations run cleanly
      await migrate(db, { migrationsFolder: join(ROOT_DIR, 'drizzle/migrations') });

      // Verify the reminders table has the language column (migration 0019)
      const cols = sqlite.prepare('PRAGMA table_info(reminders)').all() as Array<{ name: string }>;
      const colNames = cols.map(c => c.name);
      expect(colNames).toContain('language');
      expect(colNames).toContain('recurrence');
      expect(colNames).toContain('claimed_at');
    });

    test('all migration files have corresponding journal entries', () => {
      const migrationsDir = join(ROOT_DIR, 'drizzle/migrations');
      const journalPath = join(migrationsDir, 'meta/_journal.json');

      const migrationFiles = readdirSync(migrationsDir)
        .filter(f => f.startsWith('00') && f.endsWith('.sql'))
        .map(f => f.replace(/\.sql$/, ''));

      // Read the journal
      const journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
      const journalTags = journal.entries.map((e: { tag: string }) => {
        return e.tag.replace(/_.+$/, '');
      });

      for (const file of migrationFiles) {
        const found = journalTags.includes(file) || journal.entries.some((e: { tag: string }) => e.tag.startsWith(file.split('_')[0]));
        expect(found).toBe(true);
      }
    });
  });
});
