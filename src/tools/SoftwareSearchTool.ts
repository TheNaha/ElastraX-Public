import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'SoftwareSearchTool' });

type SearchResult = {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
};

type SearchResponse = {
  results?: SearchResult[];
};

export class SoftwareSearchTool extends BaseTool<ToolArgs & { query?: string }> {
  readonly name = 'software_search';
  readonly description = 'Search for PC software, applications, and cracks across trusted sites (FileCR, FMHY, rsload, etc). Use this tool ONLY when the user is explicitly looking to download or find information about cracked/repacked desktop software or applications. Do NOT use this for video games or general web search.';
  readonly aliases = ['searchsoftware', 'findsoftware'];
  readonly category = 'utility';
  readonly permissions = 'user';
  override readonly alwaysLoad = true;
  override readonly triggerPatterns = [/\b(software|app|apps|application|applications|filecr|rsload|crack|cracked)\b/i];

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
              description: 'The name of the software to search for (e.g. "Photoshop", "Premiere Pro", "IDM").',
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
      'filecr.com',
      'rsload.net',
      'lrepacks.net',
      'cybermania.ws',
      'm0nkrus.ws',
      'fmhy.net',
      'reddit.com/r/FREEMEDIAHECKYEAH',
      'reddit.com/r/Piracy',
      'rutracker.org',
      'soft98.ir'
    ];
    
    // Do a general search to include untrusted sites
    const fullQuery = query;

    log.debug({ query: fullQuery }, 'Software search initiated');

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
        return `No software downloads found for: "${query}".`;
      }

      const textResults = data.results.slice(0, 10).map((item, idx) => {
        const itemUrl = item.url || '';
        const isTrusted = trustedSites.some(site => itemUrl.includes(site));
        const status = isTrusted ? '[✅ TRUSTED]' : '[⚠️ UNTRUSTED - USE CAUTION]';
        return ` • *[${idx + 1}] ${status} ${item.title || 'Unknown'}*\n   *URL:* ${itemUrl}\n   *Info:* ${item.content || item.snippet || ''}`;
      }).join('\n\n');

      return `Software Search Results for "${query}":\n\n${textResults}`;
    } catch (err) {
      log.error({ err, query }, 'Software search failed');
      return `Failed to search software for "${query}".`;
    }
  }
}
