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
import { t } from '../utils/i18n';

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
      // `limit` is declared in the schema and honoured by `execute`, so it has
      // to be part of the variant as well. The validator rejects any argument
      // the variant does not list, so without this the parameter was
      // permanently unreachable: the model asked for `limit` and got
      // "$.limit: unexpected for action search" back, every time.
      { value: 'search', arguments: [{ name: 'query', kind: 'string', required: true }, { name: 'limit', kind: 'number', required: false }] },
      { value: 'latest', arguments: [{ name: 'limit', kind: 'number', required: false }] },
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
    const lang = ctx.language ?? 'en';
    const jellyfin = MediaService.createJellyfinClient();
    if (!jellyfin.isConfigured) return t(lang, 'media_library.not_configured');

    const action = args.action || 'search';
    const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit) || 10)));
    const ownedUserId = await getOwnedJellyfinUser(ctx);
    if (!ownedUserId && !isPublicLibraryEnabled()) return t(lang, 'media_library.not_linked');
    if ((action === 'link' || action === 'info') && !ownedUserId) return t(lang, 'media_library.verified_binding_required');

    log.debug({ action, query: args.query, itemId: args.item_id, ownedUserId: !!ownedUserId }, 'MediaLibrary action');

    try {
      switch (action) {
        case 'search': {
          if (!args.query?.trim()) return t(lang, 'media_library.no_query');
          const result = await jellyfin.searchItems(args.query.trim(), { userId: ownedUserId ?? undefined, limit, includeTypes: ['Movie', 'Series', 'Episode'] });
          if (result.Items.length === 0) return t(lang, 'media_library.no_results', { query: args.query });
          const lines = result.Items.slice(0, limit).map((item, i) => formatItem(item, i + 1, jellyfin.getWatchLink(item.Id)));
          return t(lang, 'media_library.search_results', { query: args.query, items: lines.join('\n\n'), total: String(result.TotalRecordCount) });
        }
        case 'latest': {
          const items = await jellyfin.getLatestMedia({ userId: ownedUserId ?? undefined, limit, includeTypes: ['Movie', 'Series'] });
          if (items.length === 0) return t(lang, 'media_library.no_recent');
          const lines = items.slice(0, limit).map((item, i) => formatItem(item, i + 1, jellyfin.getWatchLink(item.Id)));
          return t(lang, 'media_library.recent_header', { items: lines.join('\n\n') });
        }
        case 'link': {
          if (!args.item_id) return t(lang, 'media_library.no_item_id');
          if (typeof (jellyfin as unknown as { searchItems?: unknown }).searchItems === 'function') {
            const visible = await jellyfin.searchItems(args.item_id, { userId: ownedUserId ?? undefined, limit: 10, includeTypes: ['Movie', 'Series', 'Episode'] });
            if (!visible.Items.some((item) => item.Id === args.item_id)) return t(lang, 'media_library.item_not_available');
          }
          const link = jellyfin.getWatchLink(args.item_id);
          return t(lang, 'media_library.watch_link', { link });
        }
        case 'info': {
          if (!args.item_id) return t(lang, 'media_library.no_item_id');
          if (typeof (jellyfin as unknown as { searchItems?: unknown }).searchItems === 'function') {
            const visible = await jellyfin.searchItems(args.item_id, { userId: ownedUserId ?? undefined, limit: 10, includeTypes: ['Movie', 'Series', 'Episode'] });
            if (!visible.Items.some((item) => item.Id === args.item_id)) return t(lang, 'media_library.item_not_available');
          }
          const item = await jellyfin.getItem(args.item_id);
          const year = item.ProductionYear ? ` (${item.ProductionYear})` : '';
          const genres = item.Genres?.length ? item.Genres.join(', ') : t(lang, 'media_library.info_na');
          return [
            t(lang, 'media_library.info_header', { name: item.Name, year }),
            t(lang, 'media_library.info_type', { type: item.Type }),
            t(lang, 'media_library.info_genres', { genres }),
            item.RunTimeTicks ? t(lang, 'media_library.info_runtime', { runtime: String(Math.round(item.RunTimeTicks / 600_000_000)) }) : t(lang, 'media_library.info_na'),
            item.Overview ? `\n${t(lang, 'media_library.info_overview', { overview: item.Overview })}` : '',
            `\n${t(lang, 'media_library.info_watch_line', { link: jellyfin.getWatchLink(item.Id) })}`,
          ].filter(Boolean).join('\n');
        }
        default:
          return t(lang, 'media_library.available_actions');
      }
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      log.error({ err, action }, 'MediaLibrary failed');
      return t(lang, 'media_library.operation_failed', { msg });
    }
  }
}
