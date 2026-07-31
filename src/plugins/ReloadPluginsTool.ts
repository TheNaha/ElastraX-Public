import { BaseTool, type ToolArgs, ToolDefinition } from '../tools/BaseTool';
import { MessageContext } from '../core/MessageContext';
import { reloadRegistry } from '../tools/index';

export class ReloadPluginsTool extends BaseTool<ToolArgs> {
  readonly name = 'reload_plugins';
  readonly description = 'Reloads the tool registry and dynamic plugins from disk.';
  readonly aliases = ['reload', 'refresh'];
  readonly category = 'admin';
  readonly permissions = 'owner';

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    };
  }

  async execute(_args: ToolArgs, _ctx: MessageContext): Promise<string> {
    try {
      await reloadRegistry();
      return '✅ Plugins reloaded successfully! The new tools are now available.';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `❌ Failed to reload plugins: ${msg}`;
    }
  }
}
