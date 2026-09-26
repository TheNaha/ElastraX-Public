/**
 * @file src/plugins/manifest.ts
 * @description Declarative manifest and permission gate for dynamically loaded plugins.
 *
 * `loadPluginTools` will import any `BaseTool` subclass it finds in this
 * directory. Without a gate, a dropped-in file silently inherits whatever
 * permission level it declares — including `owner`, which reaches broadcast,
 * group administration and plugin reloading. Nothing in the registry recorded
 * what a plugin asked for, so there was no way to review or restrict it.
 *
 * A plugin opts in to review by exporting a `pluginManifest`:
 *
 * ```ts
 * export const pluginManifest = {
 *   name: 'my-plugin',
 *   version: '1.0.0',
 *   permissions: ['user'],
 * };
 * ```
 *
 * The declared permissions are checked against an operator allowlist before the
 * tool is admitted. A plugin with no manifest is still loadable (so existing
 * plugins keep working) but is reported as unmanifested so the gap is visible.
 */

/** Permission levels a plugin may declare, ordered least to most privileged. */
export const PLUGIN_PERMISSION_LEVELS = ['user', 'premium', 'admin', 'owner'] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSION_LEVELS)[number];

/**
 * Permissions a plugin may claim without explicit operator opt-in. Anything
 * beyond this can change bot-wide or destructive state, so it must be named in
 * `PLUGIN_ALLOWED_PERMISSIONS`.
 */
export const DEFAULT_PLUGIN_ALLOWED_PERMISSIONS: readonly PluginPermission[] = ['user', 'premium'];

export type PluginManifest = {
  name: string;
  version: string;
  description?: string;
  /** Highest permission level the plugin claims. */
  permissions: readonly string[];
  enabled?: boolean;
};

export type PluginManifestValidation =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a raw `pluginManifest` export. Returns a reason rather than throwing,
 * because a malformed manifest should disable one plugin, not abort the boot.
 */
export function validatePluginManifest(raw: unknown): PluginManifestValidation {
  if (!isPlainObject(raw)) return { ok: false, reason: 'manifest is not an object' };

  const name = raw.name;
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name.trim())) {
    return { ok: false, reason: 'manifest.name must be a short alphanumeric identifier' };
  }
  const version = raw.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version.trim())) {
    return { ok: false, reason: 'manifest.version must be a semver string' };
  }
  const permissions = raw.permissions;
  if (!Array.isArray(permissions) || permissions.length === 0) {
    return { ok: false, reason: 'manifest.permissions must be a non-empty array' };
  }
  for (const permission of permissions) {
    if (typeof permission !== 'string' || !PLUGIN_PERMISSION_LEVELS.includes(permission as PluginPermission)) {
      return {
        ok: false,
        reason: `manifest.permissions contains an unknown level "${String(permission)}" `
          + `(expected one of ${PLUGIN_PERMISSION_LEVELS.join(', ')})`,
      };
    }
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    return { ok: false, reason: 'manifest.description must be a string when present' };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    return { ok: false, reason: 'manifest.enabled must be a boolean when present' };
  }

  return {
    ok: true,
    manifest: {
      name: name.trim(),
      version: version.trim(),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      permissions: permissions.map(String),
      ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
    },
  };
}

/** The most privileged level a manifest claims, or null when it claims none. */
export function highestClaimedPermission(manifest: PluginManifest): PluginPermission | null {
  let highest: PluginPermission | null = null;
  for (const permission of manifest.permissions) {
    const index = PLUGIN_PERMISSION_LEVELS.indexOf(permission as PluginPermission);
    if (index < 0) continue;
    if (highest === null || index > PLUGIN_PERMISSION_LEVELS.indexOf(highest)) {
      highest = permission as PluginPermission;
    }
  }
  return highest;
}

export type PluginAdmission =
  | { allowed: true; manifest: PluginManifest | null; reason?: string }
  | { allowed: false; reason: string };

/**
 * Decide whether a manifest may be loaded given the operator's allowlist.
 * An unmanifested plugin is allowed but reported, so the missing review is
 * visible in logs and in the plugin listing.
 */
export function admitPluginManifest(
  raw: unknown,
  allowedPermissions: readonly PluginPermission[],
): PluginAdmission {
  if (raw === undefined) {
    return { allowed: true, manifest: null, reason: 'no manifest declared; loaded unreviewed' };
  }
  const validation = validatePluginManifest(raw);
  if (!validation.ok) return { allowed: false, reason: validation.reason };
  const manifest = validation.manifest;
  if (manifest.enabled === false) return { allowed: false, reason: 'manifest declares enabled: false' };

  const denied = manifest.permissions.filter(
    permission => !allowedPermissions.includes(permission as PluginPermission),
  );
  if (denied.length > 0) {
    return {
      allowed: false,
      reason: `declares permission(s) not in the operator allowlist: ${denied.join(', ')} `
        + `(allowed: ${allowedPermissions.join(', ') || 'none'})`,
    };
  }
  return { allowed: true, manifest };
}

/** Parse `PLUGIN_ALLOWED_PERMISSIONS`, falling back to the safe default set. */
export function resolveAllowedPluginPermissions(raw: string | undefined): PluginPermission[] {
  const parsed = (raw ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(value => PLUGIN_PERMISSION_LEVELS.includes(value as PluginPermission)) as PluginPermission[];
  return parsed.length > 0 ? [...new Set(parsed)] : [...DEFAULT_PLUGIN_ALLOWED_PERMISSIONS];
}
