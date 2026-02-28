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
  test('should display menu with mock tool (default English)', async () => {
    const mockTools = [new MockTool()];
    const menuTool = new MenuTool(() => mockTools);

    // ctx without language defaults to English
    const ctx = { senderName: 'User', isBotMentioned: false } as MessageContext;

    const result = await menuTool.execute({}, ctx);

    expect(result).toContain('MOCK');
    expect(result).toContain('/mock_tool (mt)');
    expect(result).toContain('Hello User!');
  });

  test('should display detailed help for mock tool in English (default)', async () => {
    const mockTools = [new MockTool()];
    const menuTool = new MenuTool(() => mockTools);

    const ctx = { senderName: 'User' } as MessageContext;

    const result = await menuTool.execute({ command_name: 'mock_tool' }, ctx);

    expect(result).toContain('*Help for: /mock_tool*');
    expect(result).toContain('*Description:* A mock tool');
    expect(result).toContain('*Aliases:* mt');
    expect(result).toContain('*Category:* mock');
  });

  test('should display detailed help for mock tool in Indonesian', async () => {
    const mockTools = [new MockTool()];
    const menuTool = new MenuTool(() => mockTools);

    const ctx = { senderName: 'User', language: 'id', isBotMentioned: false } as MessageContext;

    const result = await menuTool.execute({ command_name: 'mock_tool' }, ctx);

    expect(result).toContain('*Bantuan untuk: /mock_tool*');
    expect(result).toContain('*Deskripsi:* A mock tool');
    expect(result).toContain('*Alias:* mt');
    expect(result).toContain('*Kategori:* mock');
  });

  test('should display menu greeting in Indonesian', async () => {
    const mockTools = [new MockTool()];
    const menuTool = new MenuTool(() => mockTools);

    const ctx = { senderName: 'User', language: 'id' } as MessageContext;

    const result = await menuTool.execute({}, ctx);

    expect(result).toContain('Halo User!');
  });
  test('should group case-insensitive categories together', async () => {
    class MockAdminTool extends BaseTool {
      name = 'admin_tool';
      description = 'Admin tool';
      aliases = [];
      category = 'Admin';
      permissions = 'admin' as const;
      get definition(): ToolDefinition {
        return {
          type: 'function',
          function: { name: this.name, description: this.description, parameters: { type: 'object', properties: {}, required: [] } },
        };
      }
      async execute() { return 'admin'; }
    }

    class MockAdminTool2 extends BaseTool {
      name = 'admin_tool2';
      description = 'Another Admin tool';
      aliases = [];
      category = 'admin';
      permissions = 'admin' as const;
      get definition(): ToolDefinition {
        return {
          type: 'function',
          function: { name: this.name, description: this.description, parameters: { type: 'object', properties: {}, required: [] } },
        };
      }
      async execute() { return 'admin2'; }
    }

    const mockTools = [new MockAdminTool(), new MockAdminTool2()];
    const menuTool = new MenuTool(() => mockTools);

    const ctx = { senderName: 'User' } as MessageContext;
    const result = await menuTool.execute({}, ctx);

    // Should only have one ADMIN group
    const adminGroups = result.match(/\*╭───「 ADMIN 」\*/g);
    expect(adminGroups).not.toBeNull();
    expect(adminGroups!.length).toBe(1);

    expect(result).toContain('/admin_tool');
    expect(result).toContain('/admin_tool2');
  });
});
