import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';
import { searchSearXng } from './searchUtils';

const log = logger.child({ module: 'GameSearchTool' });

export class GameSearchTool extends BaseTool<ToolArgs & { query?: string }> {
  readonly name = 'game_search';
  readonly description = 'Search for PC games, repacks, and cracks across safe/trusted sites (FitGirl, DODI, SteamRIP, CS.RIN.RU, GOG-Games). Use this tool ONLY when the user is explicitly looking to download or find information about cracked/repacked video games. Do NOT use this for general web search or movies.';
  readonly aliases = ['searchgame', 'findgame'];
  readonly category = 'utility';
  readonly permissions = 'user';
  override readonly alwaysLoad = true;
  override readonly triggerPatterns = [/\b(game|games|repack|repacks|steamrip|fitgirl|dodi|crack|cracked)\b/i];

  private readonly searxngUrl: string;

  constructor() {
    super();
    this.searxngUrl = process.env.SEARXNG_URL || '';
  }

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
              description: 'The name of the video game to search for (e.g. "Elden Ring", "Cyberpunk 2077").',
            },
          },
          required: ['query'],
        },
      },
    };
  }

  async execute(args: ToolArgs & { query?: string }, _ctx: MessageContext): Promise<string> {
    const query = args.query;
    if (!query) return 'Error: query parameter is missing.';
    if (!this.searxngUrl) return 'Error: SEARXNG_URL environment variable is not configured.';

    // Trusted domains mimicking hizsearch
    const trustedSites = [
      'fitgirl-repacks.site',
      'steamrip.com',
      'dodi-repacks.site',
      'gog-games.to',
      'online-fix.me',
      'cs.rin.ru',
      'csrin.org',
      'elamigos.site',
      'rutracker.org',
      'ankergames.net',
      'forum.torrminatorr.com',
      'gamebounty.world',
      'kaoskrew.org',
      'astral-games.xyz',
      'union-crax.xyz',
      'steamunderground.net',
      'ovagames.com'
    ];

    log.debug({ query }, 'Game search initiated');

    try {
      const uniqueResults = await searchSearXng(query, this.searxngUrl, {
        trustedSites,
        generalQuerySuffix: 'crack OR repack OR torrent OR download',
        maxResults: 15,
      });

      if (uniqueResults.length === 0) {
        return `No game downloads found for: "${query}".`;
      }

      const textResults = uniqueResults.map((item, idx) => {
        const itemUrl = item.url || '';
        const isTrusted = trustedSites.some((site) => itemUrl.includes(site));
        const status = isTrusted ? '[✅ TRUSTED]' : '[⚠️ UNTRUSTED - USE CAUTION]';
        return ` • *[${idx + 1}] ${status} ${item.title || 'Unknown'}*\n   *URL:* ${itemUrl}\n   *Info:* ${item.content || item.snippet || ''}`;
      }).join('\n\n');

      return `Game Search Results for "${query}":\n\n${textResults}`;
    } catch (err) {
      log.error({ err, query }, 'Game search failed');
      return `Failed to search games for "${query}".`;
    }
  }
}
