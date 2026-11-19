/**
 * @file src/tools/FindToolsTool.ts
 * @description Meta-tool for on-demand tool discovery (inspired by Anthropic Tool Search Tool).
 *
 * Always loaded into the LLM context alongside 2-3 essential tools.
 * When the model calls `find_tools`, a local keyword search is performed
 * against the tool registry and matching tool names + one-line descriptions
 * are returned.  The agent loop then injects the *full* schemas of discovered
 * tools into subsequent LLM turns so the model can invoke them.
 */

import { BaseTool, type ToolArgs, type ToolDefinition, type ToolResult } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { ToolSearchIndex } from '../agent/ToolSearchIndex';
import { isToolAccessible } from './access';
import { t } from '../utils/i18n';
import { resolveSenderHasBinding } from '../utils/toolAccess';

interface FindToolsArgs extends ToolArgs {
  query: string;
}

/** Singleton reference — set by the tool registry at startup. */
let searchIndex: ToolSearchIndex | undefined;

export function setToolSearchIndex(index: ToolSearchIndex): void {
  searchIndex = index;
}

export class FindToolsTool extends BaseTool<FindToolsArgs> {
  readonly name = 'find_tools';
  readonly description = 'Search for available bot capabilities by keyword. Returns matching tools you can then call.';
  readonly aliases: string[] = [];
  readonly category = 'utility';
  readonly permissions = 'user';
  override readonly alwaysLoad = true;

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Keywords describing the capability you need (e.g. "sticker", "download video", "group admin").',
            },
          },
          required: ['query'],
        },
      },
    };
  }

  /**
   * Returns a list of matching tool names + descriptions.
   * The agent loop detects that `find_tools` was called and uses
   * the ToolSearchIndex directly to inject full schemas of discovered tools.
   */
  async execute(args: FindToolsArgs, ctx: MessageContext): Promise<ToolResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const lang = ctx.language ?? 'en';
    if (!query) {
      return t(lang, 'find_tools.no_query');
    }

    if (!searchIndex) {
      return t(lang, 'find_tools.unavailable');
    }

    const candidates = searchIndex.search(query, 1000);
    const roles = typeof ctx.resolveRoles === 'function' ? await ctx.resolveRoles() : [];
    const hasBinding = ctx.hasBinding ?? (candidates.some(candidate => candidate.tool.requiresBinding)
      ? await resolveSenderHasBinding(ctx.senderId, ctx.platform)
      : undefined);
    const accessContext = {
      roles,
      isGroup: ctx.isGroup,
      isOwner: roles.includes('owner'),
      platform: ctx.platform,
      hasBinding,
    };
    const results = [];
    for (const candidate of candidates) {
      const tool = candidate.tool;
      // Share the registry's predicate: this loop also used to advertise
      // disabled tools and binding-gated tools the agent would refuse.
      if (!isToolAccessible(tool, accessContext)) continue;
      results.push(candidate);
      if (results.length >= 7) break;
    }
    if (results.length === 0) {
      return t(lang, 'find_tools.none', { query });
    }

    const lines = results.map((r) => ` • *\`${r.name}\`* — ${r.description}`);
    return t(lang, 'find_tools.found', { count: String(results.length), items: lines.join('\n\n') });
  }
}
