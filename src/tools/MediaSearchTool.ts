/**
 * @file src/tools/MediaSearchTool.ts
 * @description Search & discover media via the request service (Seerr).
 */

import { BaseTool, type ToolDefinition, type ToolResult } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { type SeerrSearchResult, type SeerrMediaStatus } from '../providers/seerr/SeerrClient';
import { MediaService } from '../utils/MediaService';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';

const log = logger.child({ module: 'MediaSearchTool' });

// MediaService is used instead of local deps

function statusLabel(status?: SeerrMediaStatus): string {
  switch (status) {
    case 5: return '✅ Available';
    case 4: return '🟡 Partially Available';
    case 3: return '⏳ Processing';
    case 2: return '⏳ Pending';
    default: return '❌ Not Available';
  }
}

function formatResult(item: SeerrSearchResult, _index: number): string {
  const title = item.title || item.name || 'Unknown';
  const year = item.releaseDate?.slice(0, 4) || item.firstAirDate?.slice(0, 4) || '';
  const rating = item.voteAverage ? `⭐ ${item.voteAverage.toFixed(1)}` : '';
  const status = statusLabel(item.mediaInfo?.status);
  const type = item.mediaType === 'tv' ? '📺' : '🎬';
  const yearStr = year ? ` (${year})` : '';
  return ` • ${type} *${title}*${yearStr} ${rating} — ${status} [ID: ${item.id}]`;
}

type MediaSearchArgs = {
  action: 'search' | 'trending' | 'discover' | 'recommend';
  query?: string;
  media_type?: 'movie' | 'tv' | 'all';
  media_id?: number;
  page?: number;
  __command?: string;
};

export class MediaSearchTool extends BaseTool {
  readonly name = 'media_search';
  readonly description = 'Search for movies and TV shows, browse trending content, or get recommendations from the media request service.';
  readonly aliases = ['search-media', 'find'];
  readonly category = 'media';
  readonly permissions = 'user';
  readonly triggerPatterns = [
    // Domain nouns + explicit media intents only. Generic verbs like
    // "search"/"find"/"cari" deliberately do NOT trigger — they collide with
    // web/game/software search and would preload this schema on most chat.
    // Missed cases fall back to find_tools discovery.
    /\b(want to watch|movies?|films?|tv shows?|series|anime|drakor|trending|nonton)\b/i,
  ];

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
              enum: ['search', 'trending', 'discover', 'recommend'],
              description: 'Action: search (by query), trending (popular now), discover (browse), recommend (similar to a title).',
            },
            query: {
              type: 'string',
              description: 'Search query text. Required for search action.',
            },
            media_type: {
              type: 'string',
              enum: ['movie', 'tv', 'all'],
              description: 'Filter by media type. Default: all.',
            },
            media_id: {
              type: 'number',
              description: 'TMDB ID for the recommend action.',
            },
            page: {
              type: 'number',
              description: 'Page number for paginated results. Default: 1.',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  async execute(args: MediaSearchArgs, _ctx: MessageContext): Promise<ToolResult> {
    const seerr = MediaService.createSeerrClient();

    if (!seerr.isConfigured) {
      return '❌ Media search service is not configured.';
    }

    const action = args.action || 'search';
    const page = args.page ?? 1;
    const mediaType = args.media_type ?? 'all';

    log.debug({ action, query: args.query, mediaType, page }, 'MediaSearch action');

    try {
      switch (action) {
        case 'search': {
          if (!args.query?.trim()) return 'Please provide a search query.';
          const results = await seerr.search(args.query.trim(), page);
          if (results.results.length === 0) return `No results found for "${args.query}".`;

          const filtered = mediaType === 'all'
            ? results.results.filter(r => r.mediaType !== 'person')
            : results.results.filter(r => r.mediaType === mediaType);

          if (filtered.length === 0) return `No ${mediaType} results found for "${args.query}".`;

          const lines = filtered.slice(0, 10).map((r, i) => formatResult(r, i + 1));
          return `🔍 *Search results for "${args.query}":*\n\n${lines.join('\n\n')}\n\nPage ${results.page}/${results.totalPages} (${results.totalResults} total)`;
        }

        case 'trending': {
          const results = await seerr.getTrending(page);
          const filtered = mediaType === 'all'
            ? results.results.filter(r => r.mediaType !== 'person')
            : results.results.filter(r => r.mediaType === mediaType);

          if (filtered.length === 0) return 'No trending content found.';

          const lines = filtered.slice(0, 10).map((r, i) => formatResult(r, i + 1));
          return `🔥 *Trending Now:*\n\n${lines.join('\n\n')}\n\nPage ${results.page}/${results.totalPages}`;
        }

        case 'discover': {
          const results = mediaType === 'tv'
            ? await seerr.discoverTv(page)
            : await seerr.discoverMovies(page);

          if (results.results.length === 0) return 'No content to discover.';

          const lines = results.results.slice(0, 10).map((r, i) => formatResult(r, i + 1));
          const label = mediaType === 'tv' ? 'TV Shows' : 'Movies';
          return `🎲 *Discover ${label}:*\n\n${lines.join('\n\n')}\n\nPage ${results.page}/${results.totalPages}`;
        }

        case 'recommend': {
          if (!args.media_id) return 'Please provide a media_id (TMDB ID) to get recommendations.';
          const mt = mediaType === 'tv' ? 'tv' : 'movie';
          const results = mt === 'tv'
            ? await seerr.getTvRecommendations(args.media_id, page)
            : await seerr.getMovieRecommendations(args.media_id, page);

          if (results.results.length === 0) return 'No recommendations found for this title.';

          const lines = results.results.slice(0, 10).map((r, i) => formatResult(r, i + 1));
          return `💡 *Recommendations:*\n\n${lines.join('\n\n')}\n\nPage ${results.page}/${results.totalPages}`;
        }

        default:
          return 'Available actions: search, trending, discover, recommend';
      }
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      log.error({ err, action }, 'MediaSearch failed');
      return `❌ Search failed: ${msg}`;
    }
  }
}
