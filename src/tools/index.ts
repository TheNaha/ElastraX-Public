/**
 * @file src/tools/index.ts
 * @description Central registry for all ElastraX tools (slash commands and LLM function calls).
 *
 * Tools are registered once at module load time.  The agent and command router look up
 * tools via the exported helper functions rather than importing each tool directly,
 * keeping them decoupled from individual implementations.
 *
 * To add a new tool:
 *  1. Create a class that extends `BaseTool` in a new file under `src/tools/`.
 *  2. Import it here and push an instance onto `toolsList`.
 *  3. The tool will automatically appear in:
 *     - `/menu` (help output)
 *     - LLM function-calling payload (if `allowTools` is enabled for the room)
 *     - The slash-command router (via the tool's `name` and `aliases`)
 *
 * Exported helpers:
 *  - `getToolByName(name)`         — Look up a tool by its exact LLM function name.
 *  - `getToolByAliasOrName(cmd)`   — Look up a tool by slash-command alias OR name.
 *  - `getToolDefinitions()`        — Return OpenAI-compatible tool definitions for all tools.
 *  - `tools`                       — The raw ordered list of all registered `BaseTool` instances.
 */

import { BaseTool } from './BaseTool';
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

// Instantiate all active tools here
const toolsList: BaseTool[] = [];

/** The ordered list of every registered tool — used by MenuTool to build the help menu. */
export const tools = toolsList;

// ── Utility / Core ────────────────────────────────────────────────────────────
toolsList.push(new WebSearchTool());
toolsList.push(new MenuTool(() => toolsList));
toolsList.push(new PingTool());
toolsList.push(new IDTool());
toolsList.push(new StatsTool());
toolsList.push(new TranslateTool());
toolsList.push(new ReminderTool());
toolsList.push(new DeleteMessageTool());
toolsList.push(new TranscribeTool());

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
// ── Owner ───────────────────────────────────────────────────────────────────────
toolsList.push(new OwnerTool());
// Build fast lookup maps for O(1) dispatch —
// toolsMap   : exact function name (as exposed to the LLM)
// aliasMap   : function name + all slash-command aliases
const toolsMap = new Map<string, BaseTool>();
const aliasMap = new Map<string, BaseTool>();

for (const tool of toolsList) {
  toolsMap.set(tool.name, tool);
  aliasMap.set(tool.name, tool);
  for (const alias of tool.aliases) {
    aliasMap.set(alias, tool);
  }
}

// Pre-compute tool definitions once at module load time to avoid mapping on every request
const cachedToolDefinitions = toolsList.map(t => t.definition);

/**
 * Look up a tool by its exact LLM function name (e.g., `'web_search'`).
 * Returns `undefined` if no matching tool is registered.
 */
export function getToolByName(name: string): BaseTool | undefined {
  return toolsMap.get(name);
}

/**
 * Returns an array of OpenAI-compatible `ToolDefinition` objects for every registered tool.
 * This array is passed directly to the LLM when function-calling is enabled for a room.
 */
export function getToolDefinitions() {
  return cachedToolDefinitions;
}

/**
 * Find a tool by either its canonical name or one of its slash-command aliases.
 * Used by the command router in `src/agent/index.ts`.
 */
export function getToolByAliasOrName(command: string): BaseTool | undefined {
  return aliasMap.get(command);
}
