import { describe, expect, test } from 'bun:test';
import { BaseTool, type ToolDefinition, type ToolResult } from '../src/tools/BaseTool';
import type { MessageContext } from '../src/core/MessageContext';

class ExampleTool extends BaseTool {
  readonly name = 'example';
  readonly description = 'Example tool';
  readonly aliases = ['ex'];
  readonly category = 'utility';
  readonly permissions = 'user';

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to echo' },
          },
          required: ['text'],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>, _ctx: MessageContext): Promise<ToolResult> {
    return String(args.text ?? '');
  }
}

describe('BaseTool', () => {
  test('provides default groupOnly and modelTier values through subclasses', async () => {
    const tool = new ExampleTool();

    expect(tool.groupOnly).toBe(false);
    expect(tool.modelTier).toBe('standard');
    expect(tool.aliases).toEqual(['ex']);
    expect(tool.permissions).toBe('user');

    const result = await tool.execute({ text: 'hello' }, {} as MessageContext);
    expect(result).toBe('hello');
  });
});