/**
 * @file src/tools/MediaRequestTool.ts
 * @description Request media and manage requests via the request service (Seerr).
 */

import { BaseTool, type ToolDefinition, type ToolResult } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { SeerrClient, type SeerrRequest } from '../providers/seerr/SeerrClient';
import { ServiceBindingService } from '../utils/ServiceBindingService';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'MediaRequestTool' });

export const mediaRequestToolDeps = {
  createSeerrClient: () => new SeerrClient(),
  bindingService: ServiceBindingService,
};

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

export class MediaRequestTool extends BaseTool {
  readonly name = 'media_request';
  readonly description = 'Request movies or TV shows to be added to the media library, or check request status.';
  readonly aliases = ['request-media', 'request'];
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
              enum: ['request', 'status', 'my-requests'],
              description: 'Action: request (submit new), status (check by ID), my-requests (list your requests).',
            },
            media_type: {
              type: 'string',
              enum: ['movie', 'tv'],
              description: 'Type of media. Required for request action.',
            },
            media_id: {
              type: 'number',
              description: 'TMDB ID of the media to request. Required for request action.',
            },
            seasons: {
              type: 'string',
              description: 'For TV: comma-separated season numbers (e.g., "1,2,3") or "all".',
            },
            request_id: {
              type: 'number',
              description: 'Request ID for status action.',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  async execute(args: MediaRequestArgs, ctx: MessageContext): Promise<ToolResult> {
    const seerr = mediaRequestToolDeps.createSeerrClient();

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
          return this.handleStatus(seerr, args);
        case 'my-requests':
          return this.handleMyRequests(seerr, ctx);
        default:
          return 'Available actions: request, status, my-requests';
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      log.error({ err, action }, 'MediaRequest failed');
      return `❌ Request failed: ${msg}`;
    }
  }

  private async handleRequest(seerr: SeerrClient, args: MediaRequestArgs, ctx: MessageContext): Promise<ToolResult> {
    if (!args.media_type) return 'Please specify media_type: movie or tv.';
    if (!args.media_id) return 'Please specify media_id (TMDB ID).';

    // Check user has a binding
    const binding = await mediaRequestToolDeps.bindingService.getBinding(ctx.senderId, ctx.platform, 'seerr');
    if (!binding) {
      return '❌ You need to link your account first. Use the connect command.';
    }

    const seerrUserId = parseInt(binding.externalUserId, 10);
    let seasons: number[] | 'all' | undefined;
    if (args.media_type === 'tv' && args.seasons) {
      if (args.seasons === 'all') {
        seasons = 'all';
      } else if (typeof args.seasons === 'string') {
        seasons = args.seasons.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      }
    }

    const request = await seerr.createRequest(args.media_type, args.media_id, {
      seasons,
      userId: seerrUserId,
    });

    const type = args.media_type === 'tv' ? '📺 TV Show' : '🎬 Movie';
    return `✅ *Request Submitted!*\n${type} (TMDB: ${args.media_id})\nRequest #${request.id} — ${requestStatusLabel(request.status)}`;
  }

  private async handleStatus(seerr: SeerrClient, args: MediaRequestArgs): Promise<ToolResult> {
    if (!args.request_id) return 'Please specify a request_id.';

    const request = await seerr.getRequestById(args.request_id);
    const type = request.type === 'tv' ? '📺' : '🎬';
    return `${type} *Request #${request.id}*\nTMDB: ${request.media.tmdbId}\nStatus: ${requestStatusLabel(request.status)}\nRequested by: ${request.requestedBy.displayName}\nCreated: ${new Date(request.createdAt).toLocaleDateString()}`;
  }

  private async handleMyRequests(seerr: SeerrClient, ctx: MessageContext): Promise<ToolResult> {
    const binding = await mediaRequestToolDeps.bindingService.getBinding(ctx.senderId, ctx.platform, 'seerr');
    if (!binding) {
      return '❌ You need to link your account first. Use the connect command.';
    }

    const seerrUserId = parseInt(binding.externalUserId, 10);
    const result = await seerr.getRequests({ requestedBy: seerrUserId, take: 15, sort: 'added' });

    if (result.results.length === 0) return 'You have no media requests.';

    const lines = result.results.map((r, i) => formatRequest(r, i + 1));
    return `📋 *Your Requests:*\n\n${lines.join('\n\n')}`;
  }
}
