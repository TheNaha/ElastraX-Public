import { describe, test, expect } from 'bun:test';
import { MenuTool } from '../src/tools/MenuTool';
import { BaseTool, ToolDefinition } from '../src/tools/BaseTool';
import { MessageContext } from '../src/core/MessageContext';

class MockTool extends BaseTool {
  name = 'mock_tool';
  description = 'A mock tool';
  aliases = ['mt'];
  category = 'mock';
  permissions = 'user' as const;
  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: { type: 'object', properties: {}, required: [] },
      },
    };
  }
  async execute() { return 'mock'; }
}

describe('MenuTool', () => {
  test('should display menu with mock tool', async () => {
    const mockTools = [new MockTool()];
    const menuTool = new MenuTool(() => mockTools);

    // partial mock of MessageContext
    const ctx = { senderName: 'User' } as MessageContext;

    const result = await menuTool.execute({}, ctx);

    expect(result).toContain('MOCK');
    expect(result).toContain('/mock_tool (mt)');
  });

  test('should display detailed help for mock tool', async () => {
    const mockTools = [new MockTool()];
    const menuTool = new MenuTool(() => mockTools);

    const ctx = { senderName: 'User' } as MessageContext;

    const result = await menuTool.execute({ command_name: 'mock_tool' }, ctx);

    expect(result).toContain('Bantuan untuk: /mock_tool');
    expect(result).toContain('Deskripsi:* A mock tool');
    expect(result).toContain('Alias:* mt');
    expect(result).toContain('Kategori:* mock');
  });
});
