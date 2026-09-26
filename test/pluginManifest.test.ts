/**
 * Tests for the plugin manifest and permission gate.
 *
 * The gap this closes: `loadPluginTools` imported any `BaseTool` subclass found
 * in src/plugins/ and admitted it at whatever permission level the file chose.
 * Nothing recorded or checked that choice, so a dropped-in file could claim
 * `owner` and reach broadcast, group administration and registry reload.
 */
import { describe, test, expect } from 'bun:test';
import {
  admitPluginManifest,
  highestClaimedPermission,
  resolveAllowedPluginPermissions,
  validatePluginManifest,
  DEFAULT_PLUGIN_ALLOWED_PERMISSIONS,
  PLUGIN_PERMISSION_LEVELS,
} from '../src/plugins/manifest';

const baseManifest = { name: 'demo', version: '1.0.0', permissions: ['user'] };

describe('plugin manifest validation', () => {
  test('accepts a well-formed manifest', () => {
    const result = validatePluginManifest(baseManifest);
    expect(result.ok).toBe(true);
  });

  test('rejects a non-object', () => {
    for (const value of [null, undefined, 42, 'x', []]) {
      expect(validatePluginManifest(value).ok).toBe(false);
    }
  });

  test('rejects a missing or malformed name', () => {
    expect(validatePluginManifest({ ...baseManifest, name: '' }).ok).toBe(false);
    expect(validatePluginManifest({ ...baseManifest, name: 'has spaces' }).ok).toBe(false);
    expect(validatePluginManifest({ ...baseManifest, name: 'a/b' }).ok).toBe(false);
    expect(validatePluginManifest({ version: '1.0.0', permissions: ['user'] }).ok).toBe(false);
  });

  test('rejects a malformed version', () => {
    expect(validatePluginManifest({ ...baseManifest, version: 'v1' }).ok).toBe(false);
    expect(validatePluginManifest({ ...baseManifest, version: 1 }).ok).toBe(false);
    expect(validatePluginManifest({ ...baseManifest, version: '1.2.3-beta' }).ok).toBe(true);
  });

  test('rejects an empty or non-array permission list', () => {
    expect(validatePluginManifest({ ...baseManifest, permissions: [] }).ok).toBe(false);
    expect(validatePluginManifest({ ...baseManifest, permissions: 'user' }).ok).toBe(false);
    expect(validatePluginManifest({ name: 'demo', version: '1.0.0' }).ok).toBe(false);
  });

  test('rejects an unknown permission level', () => {
    // The whole point: a typo must not silently widen access.
    const result = validatePluginManifest({ ...baseManifest, permissions: ['user', 'superuser'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('superuser');
  });

  test('rejects a non-boolean enabled flag', () => {
    expect(validatePluginManifest({ ...baseManifest, enabled: 'yes' }).ok).toBe(false);
    expect(validatePluginManifest({ ...baseManifest, enabled: false }).ok).toBe(true);
  });
});

describe('highest claimed permission', () => {
  test('orders levels by privilege', () => {
    expect(highestClaimedPermission({ name: 'a', version: '1.0.0', permissions: ['user'] })).toBe('user');
    expect(highestClaimedPermission({ name: 'a', version: '1.0.0', permissions: ['user', 'admin'] })).toBe('admin');
    expect(highestClaimedPermission({ name: 'a', version: '1.0.0', permissions: ['premium', 'owner'] })).toBe('owner');
    expect(highestClaimedPermission({ name: 'a', version: '1.0.0', permissions: ['owner', 'user'] })).toBe('owner');
  });

  test('is null when nothing valid is claimed', () => {
    expect(highestClaimedPermission({ name: 'a', version: '1.0.0', permissions: ['nonsense'] })).toBeNull();
  });
});

describe('plugin admission', () => {
  test('admits a plugin within the allowlist', () => {
    const result = admitPluginManifest(baseManifest, ['user', 'premium']);
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.manifest?.name).toBe('demo');
  });

  test('refuses a plugin claiming a permission outside the allowlist', () => {
    const result = admitPluginManifest({ ...baseManifest, permissions: ['owner'] }, ['user', 'premium']);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain('owner');
  });

  test('refuses an admin-level plugin under the default allowlist', () => {
    const result = admitPluginManifest({ ...baseManifest, permissions: ['admin'] }, DEFAULT_PLUGIN_ALLOWED_PERMISSIONS);
    expect(result.allowed).toBe(false);
  });

  test('admits an owner-level plugin only when the operator opts in', () => {
    const result = admitPluginManifest({ ...baseManifest, permissions: ['owner'] }, ['user', 'premium', 'admin', 'owner']);
    expect(result.allowed).toBe(true);
  });

  test('refuses a malformed manifest rather than loading it unchecked', () => {
    const result = admitPluginManifest({ name: 'x' }, ['user', 'premium', 'admin', 'owner']);
    expect(result.allowed).toBe(false);
  });

  test('honours enabled: false', () => {
    const result = admitPluginManifest({ ...baseManifest, enabled: false }, ['user', 'premium', 'admin', 'owner']);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain('enabled');
  });

  test('an unmanifested plugin still loads but is reported as unreviewed', () => {
    // Backwards compatibility: pre-existing plugins keep working, but the gap
    // is surfaced rather than invisible.
    const result = admitPluginManifest(undefined, ['user', 'premium']);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.manifest).toBeNull();
      expect(result.reason).toContain('unreviewed');
    }
  });
});

describe('allowlist resolution', () => {
  test('falls back to the safe default when unset or empty', () => {
    expect(resolveAllowedPluginPermissions(undefined)).toEqual(['user', 'premium']);
    expect(resolveAllowedPluginPermissions('')).toEqual(['user', 'premium']);
    expect(resolveAllowedPluginPermissions('  ')).toEqual(['user', 'premium']);
  });

  test('parses a comma-separated list, trimming and de-duplicating', () => {
    expect(resolveAllowedPluginPermissions(' owner , user ,owner')).toEqual(['owner', 'user']);
  });

  test('ignores unrecognised entries but keeps the valid ones', () => {
    expect(resolveAllowedPluginPermissions('user,root,admin')).toEqual(['user', 'admin']);
  });

  test('is case-insensitive', () => {
    expect(resolveAllowedPluginPermissions('OWNER')).toEqual(['owner']);
  });

  test('falls back when every entry is invalid', () => {
    expect(resolveAllowedPluginPermissions('root,superuser')).toEqual(['user', 'premium']);
  });

  test('every declared level is representable in the allowlist', () => {
    expect(resolveAllowedPluginPermissions(PLUGIN_PERMISSION_LEVELS.join(','))).toEqual([...PLUGIN_PERMISSION_LEVELS]);
  });
});
