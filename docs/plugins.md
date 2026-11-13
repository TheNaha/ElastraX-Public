# Plugins

Tools dropped into `src/plugins/` are loaded automatically at startup. Each plugin must export a `pluginManifest` whose permissions cover every tool it exports; otherwise the plugin is refused. A file dropped into the directory cannot silently claim elevated access.

## Plugin loading

The loader (`src/tools/registry.ts`, `loadPluginTools`):

1. Reads every `.ts` file in `src/plugins/` (excluding `.d.ts`).
2. Rejects any file whose realpath escapes the plugins directory (path-traversal guard).
3. Imports the module and reads `module.pluginManifest`.
4. Calls `admitPluginManifest(manifest, allowedPermissions)` from `src/plugins/manifest.ts`; if not allowed, the plugin is refused and logged.
5. Instantiates every exported `BaseTool` subclass (or tool instance).
6. Validates each tool's metadata (valid command key, valid aliases).
7. Calls `admitPluginTools(manifest, tools, allowedPermissions)`: binds the manifest to what the file actually exports, so a plugin cannot declare `permissions: ['user']` and still register an `owner` tool.
8. Reports the result as `loaded`, `loaded-unreviewed` (no manifest), or `refused` (with reason).

Reports are surfaced through `getPluginLoadReports()` and visible in the admin dashboard's Tools view.

## Plugin manifest

A plugin exports:

```ts
export const pluginManifest = {
  name: 'my-plugin',
  version: '1.0.0',
  permissions: ['user', 'premium'],
};
```

`admitPluginManifest` compares the manifest's declared permissions against `PLUGIN_ALLOWED_PERMISSIONS` (env var, comma-separated; default `user,premium`). A permission not in the allowed set causes refusal.

## Permissions

Levels are ordered: `user` < `premium` < `admin` < `owner`. `owner` satisfies every level.

- `PLUGIN_ALLOWED_PERMISSIONS` defaults to `user,premium` when unset.
- A plugin declaring `admin` or `owner` permissions requires those values in `PLUGIN_ALLOWED_PERMISSIONS`.

## Reloading plugins

The bundled `reload_plugins` tool is an owner-level plugin. It is not registered by default. To enable it:

```env
PLUGIN_ALLOWED_PERMISSIONS=owner
ENABLE_PLUGIN_RELOAD=true
```

Then `/reload` hot-reloads plugin tools from `src/plugins/`. The reload is serialized through `reloadRegistry()` (a promise chain so concurrent reloads don't race).

## Bundled plugins

- `src/plugins/ReloadPluginsTool.ts` — owner-only `/reload` tool.

## Plugin contract

Each plugin tool must extend `BaseTool` and declare:
- `name` — valid command key (`/^(?:\?|[a-z0-9])[a-z0-9_?.-]{0,63}$/i`).
- `aliases` — array of valid alias strings.
- `permissions` — must be covered by the manifest and `PLUGIN_ALLOWED_PERMISSIONS`.
- `metadata.access.mutability` — `read`, `local-write`, `external-mutation`, or `admin`.
- `cost` — mutating cost for the per-user per-60s admission budget (`TOOL_MUTATION_COST_LIMIT`, default 100).
- `triggerPatterns` — optional regexes for smart tool loading.
- `alwaysLoad` — whether the tool is always loaded in `search` mode.

## Verification

```
bun test --no-env-file test/pluginManifest.test.ts
bun test --no-env-file test/registry.reload.test.ts
bun test --no-env-file test/registry.edge.test.ts
```