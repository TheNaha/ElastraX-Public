import { expect, test, describe } from 'bun:test';
import { WebSearchTool } from '../src/tools/WebSearchTool';

describe('WebSearchTool', () => {
  test('should have a name and description', () => {
    const tool = new WebSearchTool();
    expect(tool.name).toBe('web_search');
    expect(tool.description).toBeString();
  });

  test('should return an error string if query is missing', async () => {
    const tool = new WebSearchTool();
    // @ts-expect-error - mock context
    const result = await tool.execute({}, {});
    expect(result).toContain('search.query_missing');
  });

  test('definition should match OpenAI schema', () => {
    const tool = new WebSearchTool();
    const def = tool.definition;
    
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('web_search');
    expect(def.function.parameters.required).toContain('query');
  });
});
