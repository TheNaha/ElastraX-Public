import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'GameSearchTool' });

type SearchResult = {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
};

type SearchResponse = {
  results?: SearchResult[];
};

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

    const trustedSites = [
      'fitgirl-repacks.site',
      'steamrip.com',
      'dodi-repacks.site',
      'gog-games.to',
      'online-fix.me',
      'cs.rin.ru',
      'elamigos.site',
      'rutracker.org',
      'ankergames.net',
      'forum.torrminatorr.com',
      'gamebounty.world',
      'kaoskrew.org'
    ];
    
    // We will do a general search so we can find untrusted sites too
    const fullQuery = query;

    log.debug({ query: fullQuery }, 'Game search initiated');

    try {
      let baseUrl = this.searxngUrl;
      if (!baseUrl.endsWith('/search') && !baseUrl.endsWith('/search/')) {
        baseUrl = baseUrl.endsWith('/') ? baseUrl + 'search' : baseUrl + '/search';
      }
      
      const url = new URL(baseUrl);
      url.search = new URLSearchParams({ q: fullQuery, format: 'json' }).toString();

      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
          'X-Forwarded-For': '127.0.0.1',
          'X-Real-IP': '127.0.0.1'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);

      const rawText = await response.text();
      const data = JSON.parse(rawText) as SearchResponse;
      
      if (!data.results || data.results.length === 0) {
        return `No game downloads found for: "${query}".`;
      }

      const textResults = data.results.slice(0, 10).map((item, idx) => {
        const itemUrl = item.url || '';
        const isTrusted = trustedSites.some(site => itemUrl.includes(site));
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
