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

// Internal state tracking for hot-reloading
const toolsMap = new Map<string, BaseTool>();
const aliasMap = new Map<string, BaseTool>();
let cachedAllDefinitions: ToolDefinition[] = [];
let cachedAlwaysLoadedDefinitions: ToolDefinition[] = [];
let discoverableTools: BaseTool[] = [];
export const toolSearchIndex = new ToolSearchIndex();
setToolSearchIndex(toolSearchIndex);

export async function reloadRegistry() {
  toolsList.length = 0;
  toolsMap.clear();
  aliasMap.clear();

  // ── Utility / Core ────────────────────────────────────────────────────────────
  toolsList.push(new WebSearchTool());
  toolsList.push(new GameSearchTool());
  toolsList.push(new SoftwareSearchTool());
  toolsList.push(new MenuTool(() => toolsList));
  toolsList.push(new PingTool());
  toolsList.push(new IDTool());
  toolsList.push(new StatsTool());
  toolsList.push(new TranslateTool());
  toolsList.push(new ReminderTool());
  toolsList.push(new DeleteMessageTool());
  toolsList.push(new TranscribeTool());
  toolsList.push(new MemoryTool());
  toolsList.push(new WebScrapeTool());
  
  // ── Media ─────────────────────────────────────────────────────────────────────
  toolsList.push(new MakeStickerTool());
  toolsList.push(new DownloadTool());
  toolsList.push(new MediaConvertTool());
  toolsList.push(new PDFTool());
  
  // ── Admin / Group ─────────────────────────────────────────────────────────────
  toolsList.push(new GroupAdminTool());
  toolsList.push(new LanguageTool());
  toolsList.push(new ConfigTool());
  toolsList.push(new RoleTool());
  
  // ── Fun / Social ──────────────────────────────────────────────────────────────
  toolsList.push(new MenfessTool());
  // ── Media Services (V7.15) ────────────────────────────────────────────────────
  toolsList.push(new MediaBindTool());
  toolsList.push(new MediaSearchTool());
  toolsList.push(new MediaRequestTool());
  toolsList.push(new MediaLibraryTool());
  // ── Owner ───────────────────────────────────────────────────────────────────────
  toolsList.push(new OwnerTool());
  // ── Meta (always-loaded) ────────────────────────────────────────────────────────
  toolsList.push(new FindToolsTool());

  // ── Dynamic Plugins ───────────────────────────────────────────────────────────
  const PLUGINS_DIR = join(process.cwd(), 'src', 'plugins');
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
  }

  const files = readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  for (const file of files) {
    try {
      const pluginPath = join(PLUGINS_DIR, file);
      // Use cache busting for hot reload
      const module = await import(`${pluginPath}?update=${Date.now()}`);
      
      for (const key of Object.keys(module)) {
        const exported = module[key];
        if (typeof exported === 'function' && exported.prototype && exported.prototype instanceof BaseTool) {
          const instance = new exported();
          toolsList.push(instance);
          log.info({ plugin: file, toolName: instance.name }, 'Loaded plugin tool');
        }
      }
    } catch (err: unknown) {
      log.error({ err, file }, 'Failed to load plugin');
    }
  }

  // Rebuild Maps
  for (const tool of toolsList) {
    toolsMap.set(tool.name, tool);
    aliasMap.set(tool.name, tool);
    for (const alias of tool.aliases) {
      aliasMap.set(alias, tool);
    }
  }

  // Rebuild Search Index
  discoverableTools = toolsList.filter((t) => !t.alwaysLoad);
  toolSearchIndex.build(discoverableTools);

  // Pre-computed definition sets
  cachedAllDefinitions = toolsList.map((t) => t.definition);
  cachedAlwaysLoadedDefinitions = toolsList
    .filter((t) => t.alwaysLoad)
    .map((t) => t.definition);

  log.info({
    toolCount: toolsList.length,
    alwaysLoaded: toolsList.filter((t) => t.alwaysLoad).map((t) => t.name),
    discoverable: discoverableTools.length,
  }, 'Tool registry (re)loaded');
}

// Initial sync build for core tools only, before plugins are loaded asynchronously
reloadRegistry().catch(e => log.error(e, 'Initial plugin load failed'));

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
