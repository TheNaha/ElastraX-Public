import { BaseTool } from './BaseTool';
import { WebSearchTool } from './WebSearchTool';
import { MenuTool } from './MenuTool';
import { MakeStickerTool } from './MakeStickerTool';
import { GroupAdminTool } from './GroupAdminTool';

// Instantiate all active tools here
export const tools: BaseTool[] = [
  new WebSearchTool(),
  new MenuTool(),
  new MakeStickerTool(),
  new GroupAdminTool(),
];

// Helper to easily grab an instance by name
export function getToolByName(name: string): BaseTool | undefined {
  return tools.find(t => t.name === name);
}

export function getToolDefinitions() {
  return tools.map(t => t.definition);
}

// Find a tool by either its name or one of its aliases
export function getToolByAliasOrName(command: string): BaseTool | undefined {
  return tools.find(t => t.name === command || t.aliases.includes(command));
}
