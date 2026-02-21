import { expect, test, describe, beforeAll } from 'bun:test';
import { MenuTool } from '../src/tools/MenuTool';
import { BaseTool, ToolDefinition } from '../src/tools/BaseTool';
import { MessageContext } from '../src/core/MessageContext';

// Mock Tools
class MockToolA extends BaseTool {
  name = 'mock_tool_a';
  description = 'Description for Tool A';
  aliases = ['mta', 'tool_a'];
  category = 'utility';
  permissions = 'user' as const;
  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: { type: 'object', properties: {}, required: [] }
      }
    };
  }
  async execute() { return 'A'; }
}

class MockToolB extends BaseTool {
  name = 'mock_tool_b';
  description = 'Description for Tool B';
  aliases = [];
  category = 'admin';
  permissions = 'admin' as const;
  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            param1: { type: 'string', description: 'Parameter 1' }
          },
          required: ['param1']
        }
      }
    };
  }
  async execute() { return 'B'; }
}

describe('MenuTool', () => {
  let menuTool: MenuTool;
  let mockTools: BaseTool[];
  let mockContext: MessageContext;

  beforeAll(() => {
    menuTool = new MenuTool();
    mockTools = [new MockToolA(), new MockToolB(), menuTool];
    menuTool.setTools(mockTools);

    mockContext = {
      senderName: 'TestUser',
      // Add other required properties for MessageContext type if needed, but we only use senderName in MenuTool
    } as any;
  });

  test('should return main menu when no command_name is provided', async () => {
    const result = await menuTool.execute({}, mockContext);

    expect(result).toContain('ElastraGPBOT Menu');
    expect(result).toContain('Halo TestUser!');
    expect(result).toContain('UTILITY');
    expect(result).toContain('/mock_tool_a');
    expect(result).toContain('ADMIN');
    expect(result).toContain('/mock_tool_b');
  });

  test('should return help for specific tool', async () => {
    const result = await menuTool.execute({ command_name: 'mock_tool_a' }, mockContext);

    expect(result).toContain('Bantuan untuk: /mock_tool_a');
    expect(result).toContain('Description for Tool A');
    expect(result).toContain('*Alias:* mta, tool_a');
    expect(result).toContain('*Kategori:* utility');
  });

  test('should return help for tool via alias', async () => {
    const result = await menuTool.execute({ command_name: 'mta' }, mockContext);

    expect(result).toContain('Bantuan untuk: /mock_tool_a');
  });

  test('should return error for unknown command', async () => {
    const result = await menuTool.execute({ command_name: 'unknown_tool' }, mockContext);

    expect(result).toContain('Command or tool "*unknown_tool*" not found');
  });

  test('should show usage and parameters for tool with parameters', async () => {
    const result = await menuTool.execute({ command_name: 'mock_tool_b' }, mockContext);

    expect(result).toContain('*Penggunaan:* /mock_tool_b <param1>');
    expect(result).toContain('*Parameter:*');
    expect(result).toContain('param1');
  });
});
