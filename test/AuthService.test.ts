import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { userRoles, rolePrivileges, userIdentities } from '../src/db/schema';
import { AuthService, BUILTIN_ROLES } from '../src/utils/AuthService';
import { IdentityService } from '../src/utils/IdentityService';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };

describe('AuthService', () => {
  let sqlite: Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS user_roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'whatsapp',
        scope TEXT NOT NULL DEFAULT 'global',
        role TEXT NOT NULL DEFAULT 'user',
        granted_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_scope_idx ON user_roles (user_id, scope);
      CREATE INDEX IF NOT EXISTS user_roles_scope_idx ON user_roles (scope, role);

      CREATE TABLE IF NOT EXISTS role_privileges (
        role TEXT PRIMARY KEY,
        max_messages_per_window INTEGER,
        rate_limit_window_sec INTEGER,
        context_limit INTEGER,
        max_download_mb INTEGER
      );

      CREATE TABLE IF NOT EXISTS user_identities (
        lid TEXT,
        pn TEXT,
        platform TEXT NOT NULL DEFAULT 'whatsapp',
        display_name TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS user_identities_lid_unique_idx ON user_identities (lid);
      CREATE UNIQUE INDEX IF NOT EXISTS user_identities_pn_unique_idx ON user_identities (pn);
    `);
    AuthService.setDepsForTesting({ db: db as any, userRoles, rolePrivileges });
    IdentityService.setDepsForTesting({ db: db as any, userIdentities, userRoles });

    delete process.env.BOT_OWNER_JID;
  });

  // ─── BUILTIN_ROLES ──────────────────────────────────────────────────

  test('BUILTIN_ROLES contains all expected roles', () => {
    expect(BUILTIN_ROLES).toContain('user');
    expect(BUILTIN_ROLES).toContain('premium');
    expect(BUILTIN_ROLES).toContain('admin');
    expect(BUILTIN_ROLES).toContain('owner');
  });

  // ─── hasPermission ──────────────────────────────────────────────────

  test('hasPermission: user role always allowed', () => {
    expect(AuthService.hasPermission(['user'], 'user')).toBe(true);
    expect(AuthService.hasPermission(['admin'], 'user')).toBe(true);
    expect(AuthService.hasPermission([], 'user')).toBe(true);
  });

  test('hasPermission: owner passes any requirement', () => {
    expect(AuthService.hasPermission(['owner'], 'admin')).toBe(true);
    expect(AuthService.hasPermission(['owner'], 'premium')).toBe(true);
    expect(AuthService.hasPermission(['owner'], 'owner')).toBe(true);
  });

  test('hasPermission: exact role match', () => {
    expect(AuthService.hasPermission(['premium'], 'premium')).toBe(true);
    expect(AuthService.hasPermission(['admin'], 'admin')).toBe(true);
  });

  test('hasPermission: missing role denied', () => {
    expect(AuthService.hasPermission(['user'], 'admin')).toBe(false);
    expect(AuthService.hasPermission(['user'], 'owner')).toBe(false);
    expect(AuthService.hasPermission(['premium'], 'admin')).toBe(false);
  });

  // ─── resolveRoles ───────────────────────────────────────────────────

  test('resolveRoles returns at least user', async () => {
    const roles = await AuthService.resolveRoles('unknown-user');
    expect(roles).toContain('user');
  });

  test('resolveRoles with matching BOT_OWNER_JID adds owner', async () => {
    process.env.BOT_OWNER_JID = 'owner@s.whatsapp.net';
    const roles = await AuthService.resolveRoles('owner@s.whatsapp.net');
    expect(roles).toContain('owner');
    expect(roles).toContain('user');
  });

  test('resolveRoles with isPlatformAdmin adds admin', async () => {
    const roles = await AuthService.resolveRoles('user-1', 'chat-1', true);
    expect(roles).toContain('admin');
  });

  test('resolveRoles with DB roles adds them', async () => {
    await db.insert(userRoles).values({
      userId: 'user-1',
      platform: 'whatsapp',
      scope: 'global',
      role: 'premium',
      grantedBy: 'owner-1',
      created_at: new Date(),
    });

    const roles = await AuthService.resolveRoles('user-1', 'chat-1');
    expect(roles).toContain('premium');
    expect(roles).toContain('user');
  });

  test('resolveRoles with scope-specific role only applies to matching chat', async () => {
    await db.insert(userRoles).values({
      userId: 'user-1',
      platform: 'whatsapp',
      scope: 'chat-1',
      role: 'admin',
      grantedBy: 'owner-1',
      created_at: new Date(),
    });

    // Role should apply when chatId matches
    const rolesInChat = await AuthService.resolveRoles('user-1', 'chat-1');
    expect(rolesInChat).toContain('admin');

    // Role should NOT apply when chatId differs
    const rolesOtherChat = await AuthService.resolveRoles('user-1', 'chat-2');
    expect(rolesOtherChat).not.toContain('admin');
  });

  test('resolveRoles with DB global role applies to any chat', async () => {
    await db.insert(userRoles).values({
      userId: 'user-1',
      platform: 'whatsapp',
      scope: 'global',
      role: 'premium',
      grantedBy: 'owner-1',
      created_at: new Date(),
    });

    const roles = await AuthService.resolveRoles('user-1', 'any-chat');
    expect(roles).toContain('premium');
  });

  // ─── getEffectivePrivileges ─────────────────────────────────────────

  test('getEffectivePrivileges merges roles with most-permissive wins', async () => {
    await db.insert(rolePrivileges).values({
      role: 'user',
      maxMessagesPerWindow: 10,
      rateLimitWindowSec: 60,
      contextLimit: 20,
      maxDownloadMb: 25,
    });
    await db.insert(rolePrivileges).values({
      role: 'premium',
      maxMessagesPerWindow: 30,
      rateLimitWindowSec: 60,
      contextLimit: 50,
      maxDownloadMb: 100,
    });

    const privileges = await AuthService.getEffectivePrivileges(['user', 'premium']);
    expect(privileges.maxMessagesPerWindow).toBe(30);
    expect(privileges.contextLimit).toBe(50);
  });

  test('getEffectivePrivileges falls back to hardcoded defaults', async () => {
    const privileges = await AuthService.getEffectivePrivileges(['user']);
    // HARDCODED.user defaults
    expect(privileges.maxMessagesPerWindow).toBe(10);
    expect(privileges.contextLimit).toBe(20);
  });

  test('getEffectivePrivileges -1 means unlimited', async () => {
    const privileges = await AuthService.getEffectivePrivileges(['owner']);
    expect(privileges.maxMessagesPerWindow).toBe(-1);
    expect(privileges.maxDownloadMb).toBe(-1);
  });

  // ─── setRole / removeRole ───────────────────────────────────────────

  test('setRole calls insert for new role', async () => {
    await AuthService.setRole('user-1', 'premium', 'global', 'whatsapp', 'owner-1');
    const roles = await AuthService.resolveRoles('user-1', 'chat-1');
    expect(roles).toContain('premium');
  });

  test('setRole replaces a different role in the same scope instead of violating UNIQUE(user_id, scope)', async () => {
    await AuthService.setRole('user-1', 'premium', 'global', 'whatsapp', 'owner-1');
    await AuthService.setRole('user-1', 'admin', 'global', 'whatsapp', 'owner-1');

    const roles = await AuthService.resolveRoles('user-1', 'chat-1');
    expect(roles).toContain('admin');
    expect(roles).not.toContain('premium');
  });

  test('removeRole with no matching entry returns false', async () => {
    const result = await AuthService.removeRole('nonexistent', 'global', 'own');
    expect(result).toBe(false);
  });

  test('removeRole with matching entry returns true', async () => {
    await AuthService.setRole('user-1', 'premium', 'global', 'whatsapp', 'owner-1');
    const result = await AuthService.removeRole('user-1', 'global', 'premium');
    expect(result).toBe(true);
  });

  // ─── meetsRequirement ───────────────────────────────────────────────

  test('meetsRequirement works correctly', () => {
    expect(AuthService.meetsRequirement('owner', 'admin')).toBe(true);
    expect(AuthService.meetsRequirement('admin', 'owner')).toBe(false);
    expect(AuthService.meetsRequirement('premium', 'premium')).toBe(true);
    expect(AuthService.meetsRequirement('user', 'admin')).toBe(false);
  });
});
