/**
 * @file src/tools/MediaRequestTool.ts
 * @description Request media and manage requests via the request service (Seerr).
 */

import { BaseTool, type ToolDefinition, type ToolResult, type ToolCommandGrammar } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { SeerrClient, type SeerrRequest } from '../providers/seerr/SeerrClient';
import { MediaService } from '../utils/MediaService';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { t, type Locale } from '../utils/i18n';

const log = logger.child({ module: 'MediaRequestTool' });

// MediaService is used instead of local deps

function requestStatusLabel(status: number, lang: Locale): string {
  switch (status) {
    case 1: return t(lang, 'media_request.status_pending');
    case 2: return t(lang, 'media_request.status_approved');
    case 3: return t(lang, 'media_request.status_declined');
    default: return t(lang, 'media_request.status_unknown', { status: String(status) });
  }
}

function formatRequest(req: SeerrRequest, _index: number, lang: Locale): string {
  const type = req.type === 'tv' ? '📺' : '🎬';
  const status = requestStatusLabel(req.status, lang);
  const tmdbId = req.media.tmdbId;
  return t(lang, 'media_request.request_label', {
    type,
    tmdbId: String(tmdbId),
    status,
    id: String(req.id),
  });
}

type MediaRequestArgs = {
  action: 'request' | 'status' | 'my-requests';
  media_type?: 'movie' | 'tv';
  media_id?: number;
  seasons?: number[] | string;
  request_id?: number;
  __command?: string;
};

export async function getOwnedSeerrUserId(ctx: MessageContext): Promise<number | null> {
  try {
    const binding = await MediaService.bindingService.getBinding(ctx.senderId, ctx.platform, 'seerr');
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
    const id = Number.parseInt(String(binding.externalUserId ?? ''), 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export class MediaRequestTool extends BaseTool {
  readonly name = 'media_request';
  readonly description = 'Request movies or TV shows to be added to the media library, or check request status.';
  readonly aliases = ['request-media', 'request'];
  readonly category = 'media';
  readonly permissions = 'user';
  override readonly requiresBinding: boolean = true;
  override readonly mutability = 'external-mutation' as const;
  override readonly commandGrammar: ToolCommandGrammar = {
    discriminator: 'action',
    variants: [
      { value: 'request', arguments: [{ name: 'media_type', kind: 'string', required: true }, { name: 'media_id', kind: 'integer', required: true }, { name: 'seasons', kind: 'string' }] },
      { value: 'status', arguments: [{ name: 'request_id', kind: 'integer', required: true }] },
      { value: 'my-requests', arguments: [] },
    ],
  };

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
              enum: ['request', 'status', 'my-requests'],
              description: 'Action: request (submit new), status (check by ID), my-requests (list your requests).',
            },
            media_type: {
              type: 'string',
              enum: ['movie', 'tv'],
              description: 'Type of media. Required for request action.',
            },
            media_id: {
              type: 'integer',
              minimum: 1,
              description: 'TMDB ID of the media to request. Required for request action.',
            },
            seasons: {
              type: 'string',
              description: 'For TV: comma-separated season numbers (e.g., "1,2,3") or "all".',
            },
            request_id: {
              type: 'integer',
              minimum: 1,
              description: 'Request ID for status action.',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  async execute(args: MediaRequestArgs, ctx: MessageContext): Promise<ToolResult> {
    const lang = (ctx.language ?? 'en') as Locale;
    const seerr = MediaService.createSeerrClient();

    if (!seerr.isConfigured) {
      return t(lang, 'media_request.not_configured');
    }

    const action = args.action || 'my-requests';
    log.debug({ action, mediaType: args.media_type, mediaId: args.media_id }, 'MediaRequest action');

    try {
      switch (action) {
        // These must be awaited: returning the promise from inside a `try` lets a
        // rejection escape the `catch` entirely, so the user never saw the
        // "Request failed" message this handler exists to produce.
        case 'request':
          return await this.handleRequest(seerr, args, ctx, lang);
        case 'status':
          return await this.handleStatus(seerr, args, ctx, lang);
        case 'my-requests':
          return await this.handleMyRequests(seerr, ctx, lang);
        default:
          return t(lang, 'media_request.available_actions');
      }
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      log.error({ err, action }, 'MediaRequest failed');
      return t(lang, 'media_request.request_failed', { msg });
    }
  }

  private async handleRequest(seerr: SeerrClient, args: MediaRequestArgs, ctx: MessageContext, lang: Locale): Promise<ToolResult> {
    if (!args.media_type) return t(lang, 'media_request.no_media_type');
    const mediaId = args.media_id;
    if (!Number.isInteger(mediaId) || (mediaId ?? 0) <= 0) return t(lang, 'media_request.invalid_media_id');

    const seerrUserId = await getOwnedSeerrUserId(ctx);
    if (seerrUserId === null) {
      return t(lang, 'media_request.not_linked_connect');
    }
    let seasons: number[] | 'all' | undefined;
    if (args.media_type === 'tv' && args.seasons) {
      if (args.seasons === 'all') {
        seasons = 'all';
      } else if (typeof args.seasons === 'string') {
        seasons = args.seasons.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      }
    }

    const request = await seerr.createRequest(args.media_type, mediaId as number, {
      seasons,
      userId: seerrUserId,
    });

    const type = args.media_type === 'tv' ? t(lang, 'media_request.tv_label') : t(lang, 'media_request.movie_label');
    return t(lang, 'media_request.request_submitted', {
      type,
      tmdbId: String(args.media_id),
      id: String(request.id),
      status: requestStatusLabel(request.status, lang),
    });
  }

  private async handleStatus(seerr: SeerrClient, args: MediaRequestArgs, ctx: MessageContext, lang: Locale): Promise<ToolResult> {
    if (!Number.isInteger(args.request_id) || (args.request_id ?? 0) <= 0) return t(lang, 'media_request.invalid_request_id');
    const ownerId = await getOwnedSeerrUserId(ctx);
    if (ownerId === null) return t(lang, 'media_request.not_linked_connect');
    const request = await seerr.getRequestById(args.request_id as number);
    const requestedBy = request.requestedBy as { id?: number; displayName?: string; email?: string } | undefined;
    if (!requestedBy || Number(requestedBy.id) !== ownerId) return t(lang, 'media_request.only_own');
    const type = request.type === 'tv' ? '📺' : '🎬';
    const requestedByLine = requestedBy.displayName
      ? t(lang, 'media_request.requested_by', { user: requestedBy.displayName })
      : t(lang, 'media_request.requested_by_you');
    return t(lang, 'media_request.status_detail', {
      type,
      id: String(request.id),
      tmdbId: String(request.media.tmdbId),
      status: requestStatusLabel(request.status, lang),
      requested_by: requestedByLine,
      created: new Date(request.createdAt).toLocaleDateString(),
    });
  }

  private async handleMyRequests(seerr: SeerrClient, ctx: MessageContext, lang: Locale): Promise<ToolResult> {
    const seerrUserId = await getOwnedSeerrUserId(ctx);
    if (seerrUserId === null) return t(lang, 'media_request.not_linked_connect');
    const result = await seerr.getRequests({ requestedBy: seerrUserId, take: 15, sort: 'added' });

    if (result.results.length === 0) return t(lang, 'media_request.my_requests_empty');

    const lines = result.results.map((r, i) => formatRequest(r, i + 1, lang));
    return t(lang, 'media_request.your_requests', { items: lines.join('\n') });
  }
}
