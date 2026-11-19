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
    expect(result).toContain('`/mock_tool` (`mt`)');
    expect(result).toContain('Hello User!');
  });

  test('should display detailed help for mock tool in English (default)', async () => {
    const mockTools = [new MockTool()];
    const menuTool = new MenuTool(() => mockTools);

    const ctx = { senderName: 'User' } as MessageContext;

    const result = await menuTool.execute({ command_name: 'mock_tool' }, ctx);

    expect(result).toContain('*Help for: `/mock_tool`*');
    expect(result).toContain('• *Description:* A mock tool');
    expect(result).toContain('• *Aliases:* `mt`');
    expect(result).toContain('• *Category:* Mock');
  });

  test('should display detailed help for mock tool in Indonesian', async () => {
    const mockTools = [new MockTool()];
    const menuTool = new MenuTool(() => mockTools);

    const ctx = { senderName: 'User', language: 'id', isBotMentioned: false } as MessageContext;

    const result = await menuTool.execute({ command_name: 'mock_tool' }, ctx);

    expect(result).toContain('*Bantuan untuk: /mock_tool*');
    expect(result).toContain('• *Deskripsi:* A mock tool');
    expect(result).toContain('• *Alias:* `mt`');
    expect(result).toContain('• *Kategori:* Mock');
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

    // Admin tools are listed only to an admin; the point of this test is the
    // category grouping, so give the caller the role the tools require.
    const ctx = { senderName: 'User', resolveRoles: async () => ['admin'] } as unknown as MessageContext;
    const result = await menuTool.execute({}, ctx);

    // Should only have one ADMIN group
    const adminGroups = result.match(/\*=== ADMIN ===\*/g);
    expect(adminGroups).not.toBeNull();
    expect(adminGroups!.length).toBe(1);

    expect(result).toContain('/admin_tool');
    expect(result).toContain('/admin_tool2');
  });

  test('hides binding-gated tools from an unbound sender', async () => {
    class MockBoundTool extends BaseTool {
      name = 'bound_tool';
      description = 'Needs a linked account';
      aliases = [];
      category = 'media';
      permissions = 'user' as const;
      override get requiresBinding(): boolean { return true; }
      get definition(): ToolDefinition {
        return {
          type: 'function',
          function: { name: this.name, description: this.description, parameters: { type: 'object', properties: {}, required: [] } },
        };
      }
      async execute() { return 'bound'; }
    }

    const menuTool = new MenuTool(() => [new MockBoundTool()]);
    const unbound = await menuTool.execute({}, { senderName: 'User', hasBinding: false } as MessageContext);
    expect(unbound).not.toContain('/bound_tool');

    const bound = await menuTool.execute({}, { senderName: 'User', hasBinding: true } as MessageContext);
    expect(bound).toContain('/bound_tool');
  });

  test('should suggest nearest command if tool not found', async () => {
    const mockTools = [new MockTool()];
    const menuTool = new MenuTool(() => mockTools);

    const ctx = { senderName: 'User' } as MessageContext;

    // "mock_tool" is the actual command name. "moock_tool" is a close typo.
    const result = await menuTool.execute({ command_name: 'moock_tool' }, ctx);

    expect(result).toContain('Did you mean "*`mock_tool`*"?');
  });

  test('should suggest nearest alias if tool not found', async () => {
    const mockTools = [new MockTool()];
    const menuTool = new MenuTool(() => mockTools);

    const ctx = { senderName: 'User' } as MessageContext;

    // "mt" is the alias. "mtt" is a close typo.
    const result = await menuTool.execute({ command_name: 'mtt' }, ctx);

    expect(result).toContain('Did you mean "*`mt`*"?');
  });
});

describe('MenuTool localisation', () => {
  class ReminderLikeTool extends BaseTool {
    name = 'reminder';
    description = 'Set, list, or cancel reminders. Supports natural time parsing and recurring schedules.';
    aliases: string[] = [];
    category = 'utility';
    permissions = 'user' as const;
    get definition(): ToolDefinition {
      return {
        type: 'function',
        function: {
          name: this.name,
          description: this.description,
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'The reminder action to perform.' },
              time: { type: 'string', description: 'When to fire the reminder.' },
            },
            required: ['action'],
          },
        },
      };
    }
    async execute() { return 'reminder'; }
  }

  test('help text follows the room language', async () => {
    const menuTool = new MenuTool(() => [new ReminderLikeTool()]);
    const ctx = { senderName: 'Budi', language: 'id' } as MessageContext;

    const help = await menuTool.execute({ command_name: 'reminder' }, ctx);

    expect(help).toContain('Mengatur, menampilkan, atau membatalkan pengingat');
    expect(help).toContain('"set" untuk membuat pengingat');
    expect(help).toContain('Kapan pengingat berbunyi');
    // The raw English source must not leak through.
    expect(help).not.toContain('Set, list, or cancel reminders');
  });

  test('falls back to the tool source text for an untranslated tool', async () => {
    const menuTool = new MenuTool(() => [new MockTool()]);
    const ctx = { senderName: 'Budi', language: 'id' } as MessageContext;

    const help = await menuTool.execute({ command_name: 'mock_tool' }, ctx);
    expect(help).toContain('A mock tool');
    expect(help).toContain('*Kategori:* Mock');
  });

  test('category headings are translated in the main menu', async () => {
    const menuTool = new MenuTool(() => [new ReminderLikeTool()]);
    const ctx = { senderName: 'Budi', language: 'id' } as MessageContext;

    const menu = await menuTool.execute({}, ctx);
    expect(menu).toContain('*=== UTILITAS ===*');
  });
});
