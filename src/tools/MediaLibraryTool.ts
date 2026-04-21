/**
 * @file src/tools/MediaLibraryTool.ts
 * @description Browse and search the media streaming library (Jellyfin).
 */

import { BaseTool, type ToolDefinition, type ToolResult } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { JellyfinClient, type JellyfinItem } from '../providers/jellyfin/JellyfinClient';
import { ServiceBindingService } from '../utils/ServiceBindingService';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'MediaLibraryTool' });

export const mediaLibraryToolDeps = {
  createJellyfinClient: () => new JellyfinClient(),
  bindingService: ServiceBindingService,
};

function formatItem(item: JellyfinItem, _index: number, watchLink: string): string {
  const type = item.Type === 'Series' ? '📺' : item.Type === 'Episode' ? '📺' : '🎬';
  const year = item.ProductionYear ? ` (${item.ProductionYear})` : '';
  let name = item.Name;
  if (item.SeriesName) {
    name = `${item.SeriesName}`;
    if (item.ParentIndexNumber !== undefined && item.IndexNumber !== undefined) {
      name += ` S${String(item.ParentIndexNumber).padStart(2, '0')}E${String(item.IndexNumber).padStart(2, '0')}`;
    }
    name += ` — ${item.Name}`;
  }
  return ` • ${type} *${name}*${year}\n   🔗 ${watchLink}`;
}

type MediaLibraryArgs = {
  action: 'search' | 'latest' | 'link' | 'info';
  query?: string;
  item_id?: string;
  limit?: number;
  __command?: string;
};

export class MediaLibraryTool extends BaseTool {
  readonly name = 'media_library';
  readonly description = 'Browse the streaming media library: search content, see latest additions, or get watch links.';
  readonly aliases = ['library', 'watching'];
  readonly category = 'media';
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
            action: {
              type: 'string',
              enum: ['search', 'latest', 'link', 'info'],
              description: 'Action: search (by query), latest (recent additions), link (get watch URL), info (detailed item info).',
            },
            query: {
              type: 'string',
              description: 'Search query. Required for search action.',
            },
            item_id: {
              type: 'string',
              description: 'Jellyfin item ID for link/info actions.',
            },
            limit: {
              type: 'number',
              description: 'Max number of results. Default: 10.',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  async execute(args: MediaLibraryArgs, ctx: MessageContext): Promise<ToolResult> {
    const jellyfin = mediaLibraryToolDeps.createJellyfinClient();

    if (!jellyfin.isConfigured) {
      return '❌ Streaming library service is not configured.';
    }

    const action = args.action || 'search';
    const limit = args.limit ?? 10;

    log.debug({ action, query: args.query, itemId: args.item_id }, 'MediaLibrary action');

    try {
      // Get user's Jellyfin userId for personalized results (optional)
      const binding = await mediaLibraryToolDeps.bindingService.getBinding(ctx.senderId, ctx.platform, 'jellyfin');
      const jellyfinUserId = binding?.externalUserId;

      switch (action) {
        case 'search': {
          if (!args.query?.trim()) return 'Please provide a search query.';
          const result = await jellyfin.searchItems(args.query.trim(), {
            userId: jellyfinUserId,
            limit,
            includeTypes: ['Movie', 'Series', 'Episode'],
          });

          if (result.Items.length === 0) return `No results found for "${args.query}" in the library.`;

          const lines = result.Items.slice(0, limit).map((item, i) =>
            formatItem(item, i + 1, jellyfin.getWatchLink(item.Id)),
          );
          return `🔍 *Library search for "${args.query}":*\n\n${lines.join('\n\n')}\n\n(${result.TotalRecordCount} total)`;
        }

        case 'latest': {
          const items = await jellyfin.getLatestMedia({
            userId: jellyfinUserId,
            limit,
            includeTypes: ['Movie', 'Series'],
          });

          if (items.length === 0) return 'No recent additions found.';

          const lines = items.slice(0, limit).map((item, i) =>
            formatItem(item, i + 1, jellyfin.getWatchLink(item.Id)),
          );
          return `📥 *Recently Added:*\n\n${lines.join('\n\n')}`;
        }

        case 'link': {
          if (!args.item_id) return 'Please provide an item_id.';
          const link = jellyfin.getWatchLink(args.item_id);
          return `🔗 Watch link: ${link}`;
        }

        case 'info': {
          if (!args.item_id) return 'Please provide an item_id.';
          const item = await jellyfin.getItem(args.item_id);
          const genres = item.Genres?.join(', ') || 'N/A';
          const runtime = item.RunTimeTicks
            ? `${Math.round(item.RunTimeTicks / 600_000_000)} min`
            : 'N/A';
          const year = item.ProductionYear ?? 'N/A';
          const link = jellyfin.getWatchLink(item.Id);

          return [
            `🎬 *${item.Name}* (${year})`,
            `📁 Type: ${item.Type}`,
            `🎭 Genres: ${genres}`,
            `⏱️ Runtime: ${runtime}`,
            item.Overview ? `\n📝 ${item.Overview}` : '',
            `\n🔗 Watch: ${link}`,
          ].filter(Boolean).join('\n');
        }

        default:
          return 'Available actions: search, latest, link, info';
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      log.error({ err, action }, 'MediaLibrary failed');
      return `❌ Library operation failed: ${msg}`;
    }
  }
}
