import { BaseTool, type ToolArgs, ToolDefinition } from '../tools/BaseTool';
import { MessageContext } from '../core/MessageContext';
import { getPluginLoadReports, reloadRegistry } from '../tools/registry';
import { getErrorMessage } from '../utils/errorUtils';

/**
 * Declares what this plugin asks for so the loader can gate it. `owner` sits
 * above the default allowlist, so this plugin only loads when an operator sets
 * `PLUGIN_ALLOWED_PERMISSIONS=owner` — which is correct, because it is the tool
 * that reloads the registry itself.
 */
export const pluginManifest = {
  name: 'reload-plugins',
  version: '1.0.0',
  description: 'Owner-only registry reload and plugin listing.',
  permissions: ['owner'],
};

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
      const reports = getPluginLoadReports();
      const refused = reports.filter(report => report.status === 'refused');
      const unreviewed = reports.filter(report => report.status === 'loaded-unreviewed');
      const loaded = reports.filter(report => report.status === 'loaded');
      const lines = [`✅ Registry reloaded: ${loaded.length} manifested plugin(s) loaded.`];
      if (unreviewed.length > 0) {
        lines.push(`⚠️ ${unreviewed.length} plugin(s) loaded with no manifest (unreviewed).`);
      }
      if (refused.length > 0) {
        lines.push(`🚫 ${refused.length} plugin(s) refused:`);
        for (const report of refused) lines.push(`   • ${report.reason ?? 'unknown reason'}`);
      }
      return lines.join('\n');
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      return `❌ Failed to reload plugins: ${msg}`;
    }
  }
}
