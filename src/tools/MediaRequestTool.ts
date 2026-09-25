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

const log = logger.child({ module: 'MediaRequestTool' });

// MediaService is used instead of local deps

function requestStatusLabel(status: number): string {
  switch (status) {
    case 1: return '⏳ Pending';
    case 2: return '✅ Approved';
    case 3: return '❌ Declined';
    default: return `Unknown (${status})`;
  }
}

function formatRequest(req: SeerrRequest, _index: number): string {
  const type = req.type === 'tv' ? '📺' : '🎬';
  const status = requestStatusLabel(req.status);
  const tmdbId = req.media.tmdbId;
  return ` • ${type} TMDB:${tmdbId} — ${status} (Request #${req.id})`;
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
    const seerr = MediaService.createSeerrClient();

    if (!seerr.isConfigured) {
      return '❌ Media request service is not configured.';
    }

    const action = args.action || 'my-requests';
    log.debug({ action, mediaType: args.media_type, mediaId: args.media_id }, 'MediaRequest action');

    try {
      switch (action) {
        case 'request':
          return this.handleRequest(seerr, args, ctx);
        case 'status':
          return this.handleStatus(seerr, args, ctx);
        case 'my-requests':
          return this.handleMyRequests(seerr, ctx);
        default:
          return 'Available actions: request, status, my-requests';
      }
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      log.error({ err, action }, 'MediaRequest failed');
      return `❌ Request failed: ${msg}`;
    }
  }

  private async handleRequest(seerr: SeerrClient, args: MediaRequestArgs, ctx: MessageContext): Promise<ToolResult> {
    if (!args.media_type) return 'Please specify media_type: movie or tv.';
    const mediaId = args.media_id;
    if (!Number.isInteger(mediaId) || (mediaId ?? 0) <= 0) return 'Please specify a valid media_id (TMDB ID).';

    const seerrUserId = await getOwnedSeerrUserId(ctx);
    if (seerrUserId === null) {
      return '❌ You need to link your account first. Use the connect command in a direct message.';
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

    const type = args.media_type === 'tv' ? '📺 TV Show' : '🎬 Movie';
    return `✅ *Request Submitted!*\n${type} (TMDB: ${args.media_id})\nRequest #${request.id} — ${requestStatusLabel(request.status)}`;
  }

  private async handleStatus(seerr: SeerrClient, args: MediaRequestArgs, ctx: MessageContext): Promise<ToolResult> {
    if (!Number.isInteger(args.request_id) || (args.request_id ?? 0) <= 0) return 'Please specify a valid request_id.';
    const ownerId = await getOwnedSeerrUserId(ctx);
    if (ownerId === null) return '❌ You need to link your account first. Use the connect command in a direct message.';
    const request = await seerr.getRequestById(args.request_id as number);
    const requestedBy = request.requestedBy as { id?: number; displayName?: string; email?: string } | undefined;
    if (!requestedBy || Number(requestedBy.id) !== ownerId) return '❌ You can only view your own media requests.';
    const type = request.type === 'tv' ? '📺' : '🎬';
    return `${type} *Request #${request.id}*\nTMDB: ${request.media.tmdbId}\nStatus: ${requestStatusLabel(request.status)}\nRequested by: ${requestedBy.displayName ?? 'you'}\nCreated: ${new Date(request.createdAt).toLocaleDateString()}`;
  }

  private async handleMyRequests(seerr: SeerrClient, ctx: MessageContext): Promise<ToolResult> {
    const seerrUserId = await getOwnedSeerrUserId(ctx);
    if (seerrUserId === null) return '❌ You need to link your account first. Use the connect command in a direct message.';
    const result = await seerr.getRequests({ requestedBy: seerrUserId, take: 15, sort: 'added' });

    if (result.results.length === 0) return 'You have no media requests.';

    const lines = result.results.map((r, i) => formatRequest(r, i + 1));
    return `📋 *Your Requests:*\n\n${lines.join('\n\n')}`;
  }
}
