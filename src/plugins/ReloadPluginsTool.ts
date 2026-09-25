import { BaseTool, type ToolArgs, ToolDefinition } from '../tools/BaseTool';
import { MessageContext } from '../core/MessageContext';
import { reloadRegistry } from '../tools/registry';
import { getErrorMessage } from '../utils/errorUtils';

export class ReloadPluginsTool extends BaseTool<ToolArgs> {
  readonly name = 'reload_plugins';
  readonly description = 'Reloads the tool registry and dynamic plugins from disk.';
  readonly aliases = ['reload', 'refresh'];
  readonly category = 'admin';
  readonly permissions = 'owner';
  override readonly optIn = true;
  override readonly mutability = 'admin' as const;
  override readonly cost = 5;

  override isEnabled(): boolean {
    return /^(1|true|yes|on)$/i.test(String(process.env.ENABLE_PLUGIN_RELOAD ?? '').trim());
  }

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

  async execute(_args: ToolArgs, ctx: MessageContext): Promise<string> {
    if (!this.isEnabled()) return 'Plugin reload is disabled until explicitly enabled by the bot owner.';
    if (!(await ctx.checkPermissions('owner'))) {
      return '❌ Only the bot owner can reload plugins.';
    }
    try {
      await reloadRegistry();
      return '✅ Plugins reloaded successfully! The new tools are now available.';
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      return `❌ Failed to reload plugins: ${msg}`;
    }
  }
}
