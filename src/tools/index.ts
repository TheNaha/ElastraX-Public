import { BaseTool } from './BaseTool';
import { WebSearchTool } from './WebSearchTool';

// Instantiate all active tools here
export const tools: BaseTool[] = [
  new WebSearchTool(),
];

// Helper to easily grab an instance by name
export function getToolByName(name: string): BaseTool | undefined {
  return tools.find(t => t.name === name);
}

// Map the tools to their OpenAI schema definition
export function getToolDefinitions() {
  return tools.map(t => t.definition);
}
