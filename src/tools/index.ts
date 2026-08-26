/**
 * @file src/tools/index.ts
 * @description Central registry for all ElastraX tools (slash commands and LLM function calls).
 *
 * Tools are registered once at module load time.  The agent and command router look up
 * tools via the exported helper functions rather than importing each tool directly,
 * keeping them decoupled from individual implementations.
 *
 * V7.14: Tools are split into "always-loaded" (sent in every LLM call) and
 * "discoverable" (loaded on-demand via `find_tools`).  This keeps the per-request
 * tool-definition overhead constant (~600 tokens) regardless of total tool count.
 *
 * To add a new tool:
 *  1. Create a class that extends `BaseTool` in a new file under `src/tools/`.
 *  2. Import it here and push an instance onto `toolsList`.
 *  3. Set `alwaysLoad = true` only if the tool is universally needed (keep ≤5).
 *  4. Optionally set `triggerPatterns` for content-based pre-loading.
 *  5. The tool will automatically appear in:
 *     - `/menu` (help output)
 *     - LLM function-calling payload (always-loaded, or after `find_tools` discovery)
 *     - The slash-command router (via the tool's `name` and `aliases`)
 *
 * Exported helpers:
 *  - `getToolByName(name)`             — Look up a tool by its exact LLM function name.
 *  - `getToolByAliasOrName(cmd)`       — Look up a tool by slash-command alias OR name.
 *  - `getToolDefinitions()`            — Return OpenAI-compatible definitions for ALL tools.
 *  - `getAlwaysLoadedDefinitions()`    — Definitions for always-loaded tools only.
 *  - `getTriggeredTools(text, mime)`   — Tools whose triggerPatterns match the message.
 *  - `toolSearchIndex`                 — The shared ToolSearchIndex for `find_tools`.
 *  - `tools`                           — The raw ordered list of all registered `BaseTool` instances.
 */

import { BaseTool, ToolDefinition } from './BaseTool';
import { WebSearchTool } from './WebSearchTool';
import { MenuTool } from './MenuTool';
import { MakeStickerTool } from './MakeStickerTool';
import { GroupAdminTool } from './GroupAdminTool';
import { LanguageTool } from './LanguageTool';
import { ConfigTool } from './ConfigTool';
import { PingTool } from './PingTool';
import { IDTool } from './IDTool';
import { StatsTool } from './StatsTool';
import { TranslateTool } from './TranslateTool';
import { DeleteMessageTool } from './DeleteMessageTool';
import { DownloadTool } from './DownloadTool';
import { MediaConvertTool } from './MediaConvertTool';
import { PDFTool } from './PDFTool';
import { ReminderTool } from './ReminderTool';
import { MenfessTool } from './MenfessTool';
import { RoleTool } from './RoleTool';
import { TranscribeTool } from './TranscribeTool';
import { OwnerTool } from './OwnerTool';
import { FindToolsTool, setToolSearchIndex } from './FindToolsTool';
import { MediaBindTool } from './MediaBindTool';
import { MediaSearchTool } from './MediaSearchTool';
import { MediaRequestTool } from './MediaRequestTool';
import { MediaLibraryTool } from './MediaLibraryTool';
import { ToolSearchIndex } from '../agent/ToolSearchIndex';
import { logger } from '../utils/logger';
import { MemoryTool } from './MemoryTool';
import { DigestTool } from './DigestTool';
import { WebScrapeTool } from './WebScrapeTool';
import { GameSearchTool } from './GameSearchTool';
import { SoftwareSearchTool } from './SoftwareSearchTool';

import { readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const log = logger.child({ module: 'ToolRegistry' });

// Instantiate all active tools here
export const toolsList: BaseTool[] = [];

/** The ordered list of every registered tool — used by MenuTool to build the help menu. */
export const tools = toolsList;

// Internal state tracking for hot-reloading.
// These are rebuilt into locals and swapped atomically at the end of
// `reloadRegistry()` so lookups never observe a half-cleared registry.
let toolsMap = new Map<string, BaseTool>();
let aliasMap = new Map<string, BaseTool>();
let cachedAllDefinitions: ToolDefinition[] = [];
let cachedAlwaysLoadedDefinitions: ToolDefinition[] = [];
let discoverableTools: BaseTool[] = [];
export const toolSearchIndex = new ToolSearchIndex();
setToolSearchIndex(toolSearchIndex);

export async function reloadRegistry() {
  const nextList: BaseTool[] = [];

  // ── Utility / Core ────────────────────────────────────────────────────────────
  nextList.push(new WebSearchTool());
  nextList.push(new GameSearchTool());
  nextList.push(new SoftwareSearchTool());
  nextList.push(new MenuTool(() => nextList));
  nextList.push(new PingTool());
  nextList.push(new IDTool());
  nextList.push(new StatsTool());
  nextList.push(new TranslateTool());
  nextList.push(new ReminderTool());
  nextList.push(new DeleteMessageTool());
  nextList.push(new TranscribeTool());
  nextList.push(new MemoryTool());
  nextList.push(new DigestTool());
  nextList.push(new WebScrapeTool());

  // ── Media ─────────────────────────────────────────────────────────────────────
  nextList.push(new MakeStickerTool());
  nextList.push(new DownloadTool());
  nextList.push(new MediaConvertTool());
  nextList.push(new PDFTool());

  // ── Admin / Group ─────────────────────────────────────────────────────────────
  nextList.push(new GroupAdminTool());
  nextList.push(new LanguageTool());
  nextList.push(new ConfigTool());
  nextList.push(new RoleTool());

  // ── Fun / Social ──────────────────────────────────────────────────────────────
  nextList.push(new MenfessTool());
  // ── Media Services (V7.15) ────────────────────────────────────────────────────
  nextList.push(new MediaBindTool());
  nextList.push(new MediaSearchTool());
  nextList.push(new MediaRequestTool());
  nextList.push(new MediaLibraryTool());
  // ── Owner ───────────────────────────────────────────────────────────────────────
  nextList.push(new OwnerTool());
  // ── Meta (always-loaded) ────────────────────────────────────────────────────────
  nextList.push(new FindToolsTool());

  // ── Dynamic Plugins ───────────────────────────────────────────────────────────
  const PLUGINS_DIR = join(import.meta.dir, '..', 'plugins');
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
  }

  const files = readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  for (const file of files) {
    try {
      const pluginPath = join(PLUGINS_DIR, file);
      // Use cache busting for hot reload
      const module = await import(`${pluginPath}?update=${Date.now()}`);

       const exportedValues = [module.default, ...Object.values(module)].filter(Boolean);
       for (const exported of exportedValues) {
         if (typeof exported === 'function' && exported.prototype && exported.prototype instanceof BaseTool) {
           const instance = new exported();
           nextList.push(instance);
           log.info({ plugin: file, toolName: instance.name }, 'Loaded plugin tool');
         }
       }
    } catch (err: unknown) {
      log.error({ err, file }, 'Failed to load plugin');
    }
  }

   // Rebuild Maps into locals; first registration wins on collisions (warned).
   const nextToolsMap = new Map<string, BaseTool>();
   const nextAliasMap = new Map<string, BaseTool>();
   for (const tool of nextList) {
     if (nextToolsMap.has(tool.name)) {
       log.warn({ toolName: tool.name }, 'Duplicate tool name detected; keeping first registration');
       continue;
     }
     nextToolsMap.set(tool.name, tool);
     for (const key of [tool.name, ...tool.aliases]) {
       const existing = nextAliasMap.get(key);
       if (existing && existing !== tool) {
         log.warn({ key, keptBy: existing.name, droppedFrom: tool.name }, 'Command name/alias collision; keeping first registration');
         continue;
       }
       nextAliasMap.set(key, tool);
     }
   }

  const nextDiscoverable = nextList.filter((t) => !t.alwaysLoad);

  // Pre-computed definition sets
  const nextAllDefinitions = nextList.map((t) => t.definition);
  const nextAlwaysLoadedDefinitions = nextList
    .filter((t) => t.alwaysLoad)
    .map((t) => t.definition);

  // ── Atomic swap (synchronous — no await between here and the assignments) ──
  toolsList.length = 0;
  toolsList.push(...nextList);
  toolsMap = nextToolsMap;
  aliasMap = nextAliasMap;
  discoverableTools = nextDiscoverable;
  toolSearchIndex.build(discoverableTools);
  cachedAllDefinitions = nextAllDefinitions;
  cachedAlwaysLoadedDefinitions = nextAlwaysLoadedDefinitions;

  log.info({
    toolCount: toolsList.length,
    alwaysLoaded: nextList.filter((t) => t.alwaysLoad).map((t) => t.name),
    discoverable: nextDiscoverable.length,
  }, 'Tool registry (re)loaded');
}

/** Resolves once the initial registry load (core tools + plugins) has completed. */
export const registryReady: Promise<void> = reloadRegistry().catch(e => {
  log.error(e, 'Initial plugin load failed');
});

/**
 * Look up a tool by its exact LLM function name (e.g., `'web_search'`).
 * Returns `undefined` if no matching tool is registered.
 */
export function getToolByName(name: string): BaseTool | undefined {
  return toolsMap.get(name);
}

/**
 * Returns an array of OpenAI-compatible `ToolDefinition` objects for every registered tool.
 * Used as the fallback when `toolLoadingMode` is `'all'`.
 */
export function getToolDefinitions() {
  return cachedAllDefinitions;
}

/**
 * Returns definitions for only the always-loaded tools (those with `alwaysLoad = true`).
 * The agent sends these plus any trigger-matched tools in the initial LLM call.
 */
export function getAlwaysLoadedDefinitions() {
  return cachedAlwaysLoadedDefinitions;
}

/**
 * Returns tools whose `triggerPatterns` match the given message text or MIME type.
 * Used to pre-load obvious tools (e.g., URL → download, image → sticker) without
 * requiring the model to call `find_tools` first.
 *
 * Patterns are tested against text AND mimeType separately to allow anchored
 * patterns (e.g., /^image\// for MIME matching) to work correctly.
 */
export function getTriggeredTools(text: string, mimeType?: string): BaseTool[] {
  const matched: BaseTool[] = [];
  for (const tool of discoverableTools) {
    if (!tool.triggerPatterns) continue;
    const isTriggered = tool.triggerPatterns.some((p) =>
      p.test(text) || (mimeType && p.test(mimeType))
    );
    if (isTriggered) {
      matched.push(tool);
    }
  }
  return matched;
}

/**
 * Find a tool by either its canonical name or one of its slash-command aliases.
 * Used by the command router in `src/agent/index.ts`.
 */
export function getToolByAliasOrName(command: string): BaseTool | undefined {
  return aliasMap.get(command);
}
