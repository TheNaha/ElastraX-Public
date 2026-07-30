import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

import { AuthService, isPrivilegeField } from '../src/utils/AuthService';
import { rolePrivileges } from '../src/db/schema';

describe('PrivilegeService', () => {
  let sqlite: Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS role_privileges (
        role TEXT PRIMARY KEY NOT NULL,
        max_messages_per_window INTEGER,
        rate_limit_window_sec INTEGER,
        context_limit INTEGER,
        max_download_mb INTEGER
      );
    `);
    AuthService.setDepsForTesting({
      db: db as typeof import('../src/db').db,
      userRoles: {} as any,
      rolePrivileges,
    });
  });

  afterEach(() => {
    AuthService.setDepsForTesting(null);
    sqlite.close();
  });

  test('getDefaults for user returns expected values', () => {
    const defaults = AuthService.getDefaultPrivileges('user');
    expect(defaults.maxMessagesPerWindow).toBe(10);
    expect(defaults.rateLimitWindowSec).toBe(60);
    expect(defaults.contextLimit).toBe(20);
    expect(defaults.maxDownloadMb).toBe(25);
  });

  test('getDefaults for owner returns unlimited values', () => {
    const defaults = AuthService.getDefaultPrivileges('owner');
    expect(defaults.maxMessagesPerWindow).toBe(-1);
    expect(defaults.maxDownloadMb).toBe(-1);
  });

  test('getDefaults for unknown role falls back to user defaults', () => {
    const defaults = AuthService.getDefaultPrivileges('custom_role');
    expect(defaults.maxMessagesPerWindow).toBe(10);
  });

  test('getForRole returns defaults when no DB overrides', async () => {
    const privs = await AuthService.getPrivilegesForRole('user');
    expect(privs.maxMessagesPerWindow).toBe(10);
  });

  test('getForRole applies DB overrides', async () => {
    await db.insert(rolePrivileges).values({
      role: 'premium',
      maxMessagesPerWindow: 50,
      rateLimitWindowSec: null,
      contextLimit: null,
      maxDownloadMb: null,
    }).onConflictDoNothing();

    const privs = await AuthService.getPrivilegesForRole('premium');
    expect(privs.maxMessagesPerWindow).toBe(50);
  });

  test('getEffective with multiple roles picks most permissive', async () => {
    const privs = await AuthService.getEffectivePrivileges(['user', 'owner']);
    expect(privs.maxMessagesPerWindow).toBe(-1);
  });

  test('isPrivilegeField accepts known fields and rejects unknown ones', () => {
    expect(isPrivilegeField('contextLimit')).toBe(true);
    expect(isPrivilegeField('unknownField')).toBe(false);
  });

  test('setOverride inserts new override', async () => {
    await AuthService.setPrivilegeOverride('premium', 'contextLimit', 100);

    const rows = await db.select().from(rolePrivileges).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contextLimit).toBe(100);
  });

  test('resetToDefaults deletes overrides', async () => {
    await db.insert(rolePrivileges).values({
      role: 'premium',
      maxMessagesPerWindow: 50,
      rateLimitWindowSec: null,
      contextLimit: null,
      maxDownloadMb: null,
    }).onConflictDoNothing();

    await AuthService.resetPrivilegesToDefaults('premium');

    const rows = await db.select().from(rolePrivileges).all();
    expect(rows).toHaveLength(0);
  });
});
