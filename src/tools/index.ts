import { BaseTool } from './BaseTool';
import { WebSearchTool } from './WebSearchTool';
import { MenuTool } from './MenuTool';
import { MakeStickerTool } from './MakeStickerTool';
import { GroupAdminTool } from './GroupAdminTool';

// Instantiate all active tools here
const toolsList: BaseTool[] = [];

export const tools = toolsList;

toolsList.push(new WebSearchTool());
toolsList.push(new MenuTool(() => toolsList));
toolsList.push(new MakeStickerTool());
toolsList.push(new GroupAdminTool());

// Inject the tools list into the menu tool to resolve circular dependency
menuTool.setTools(tools);

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
