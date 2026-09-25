/**
 * @file src/tools/MediaLibraryTool.ts
 * @description Browse and search the media streaming library (Jellyfin).
 */

import { BaseTool, type ToolDefinition, type ToolResult, type ToolCommandGrammar } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { type JellyfinItem } from '../providers/jellyfin/JellyfinClient';
import { MediaService } from '../utils/MediaService';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';

const log = logger.child({ module: 'MediaLibraryTool' });

// MediaService is used instead of local deps

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

export function isPublicLibraryEnabled(): boolean {
  return [process.env.JELLYFIN_PUBLIC_LIBRARY, process.env.MEDIA_PUBLIC_LIBRARY, process.env.ENABLE_MEDIA_LIBRARY, process.env.JELLYFIN_PUBLIC_MODE]
    .some((value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim()));
}

export async function getOwnedJellyfinUser(ctx: MessageContext): Promise<string | null> {
  try {
    const binding = await MediaService.bindingService.getBinding(ctx.senderId, ctx.platform, 'jellyfin');
    if (!binding) return null;
    if ((binding as { platform?: string }).platform && (binding as { platform: string }).platform !== ctx.platform) return null;
    if (binding.metadata) {
      try {
        const metadata = JSON.parse(binding.metadata) as { verified?: unknown };
        if (metadata.verified !== true) return null;
      } catch {
        return null;
      }
    }
    const userId = String(binding.externalUserId ?? '').trim();
    return userId || null;
  } catch {
    return null;
  }
}

export class MediaLibraryTool extends BaseTool {
  readonly name = 'media_library';
  readonly description = 'Browse the streaming media library: search content, see latest additions, or get watch links.';
  readonly aliases = ['library', 'watching'];
  readonly category = 'media';
  readonly permissions = 'user';
  override readonly mutability = 'read';
  override readonly requiresBinding: boolean = true;
  override readonly commandGrammar: ToolCommandGrammar = {
    discriminator: 'action',
    variants: [
      { value: 'search', arguments: [{ name: 'query', kind: 'string', required: true }] },
      { value: 'latest', arguments: [] },
      { value: 'link', arguments: [{ name: 'item_id', kind: 'string', required: true }] },
      { value: 'info', arguments: [{ name: 'item_id', kind: 'string', required: true }] },
    ],
  };
  override readonly noArgAliases = ['library', 'watching'];

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
    const jellyfin = MediaService.createJellyfinClient();
    if (!jellyfin.isConfigured) return '❌ Streaming library service is not configured.';

    const action = args.action || 'search';
    const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit) || 10)));
    const ownedUserId = await getOwnedJellyfinUser(ctx);
    if (!ownedUserId && !isPublicLibraryEnabled()) return '❌ Link your Jellyfin account in a direct message before using the library.';
    if ((action === 'link' || action === 'info') && !ownedUserId) return '❌ A verified Jellyfin binding is required for this action.';

    log.debug({ action, query: args.query, itemId: args.item_id, ownedUserId: !!ownedUserId }, 'MediaLibrary action');

    try {
      switch (action) {
        case 'search': {
          if (!args.query?.trim()) return 'Please provide a search query.';
          const result = await jellyfin.searchItems(args.query.trim(), { userId: ownedUserId ?? undefined, limit, includeTypes: ['Movie', 'Series', 'Episode'] });
          if (result.Items.length === 0) return `No results found for "${args.query}" in the library.`;
          const lines = result.Items.slice(0, limit).map((item, i) => formatItem(item, i + 1, jellyfin.getWatchLink(item.Id)));
          return `🔍 *Library search for "${args.query}":*\n\n${lines.join('\n\n')}\n\n(${result.TotalRecordCount} total)`;
        }
        case 'latest': {
          const items = await jellyfin.getLatestMedia({ userId: ownedUserId ?? undefined, limit, includeTypes: ['Movie', 'Series'] });
          if (items.length === 0) return 'No recent additions found.';
          const lines = items.slice(0, limit).map((item, i) => formatItem(item, i + 1, jellyfin.getWatchLink(item.Id)));
          return `📥 *Recently Added:*\n\n${lines.join('\n\n')}`;
        }
        case 'link': {
          if (!args.item_id) return 'Please provide an item_id.';
          if (typeof (jellyfin as unknown as { searchItems?: unknown }).searchItems === 'function') {
            const visible = await jellyfin.searchItems(args.item_id, { userId: ownedUserId ?? undefined, limit: 10, includeTypes: ['Movie', 'Series', 'Episode'] });
            if (!visible.Items.some((item) => item.Id === args.item_id)) return '❌ That item is not available to your Jellyfin account.';
          }
          const link = jellyfin.getWatchLink(args.item_id);
          return `🔗 Watch link: ${link}`;
        }
        case 'info': {
          if (!args.item_id) return 'Please provide an item_id.';
          if (typeof (jellyfin as unknown as { searchItems?: unknown }).searchItems === 'function') {
            const visible = await jellyfin.searchItems(args.item_id, { userId: ownedUserId ?? undefined, limit: 10, includeTypes: ['Movie', 'Series', 'Episode'] });
            if (!visible.Items.some((item) => item.Id === args.item_id)) return '❌ That item is not available to your Jellyfin account.';
          }
          const item = await jellyfin.getItem(args.item_id);
          const genres = item.Genres?.join(', ') || 'N/A';
          const runtime = item.RunTimeTicks ? `${Math.round(item.RunTimeTicks / 600_000_000)} min` : 'N/A';
          const year = item.ProductionYear ?? 'N/A';
          return [`🎬 *${item.Name}* (${year})`, `📁 Type: ${item.Type}`, `🎭 Genres: ${genres}`, `⏱️ Runtime: ${runtime}`, item.Overview ? `\n📝 ${item.Overview}` : '', `\n🔗 Watch: ${jellyfin.getWatchLink(item.Id)}`].filter(Boolean).join('\n');
        }
        default:
          return 'Available actions: search, latest, link, info';
      }
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      log.error({ err, action }, 'MediaLibrary failed');
      return `❌ Library operation failed: ${msg}`;
    }
  }
}
