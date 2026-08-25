import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';
import { searchSearXng } from './searchUtils';

const log = logger.child({ module: 'SoftwareSearchTool' });

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
      'soft98.ir',
      'cracksurl.com',
      'mobilism.org',
      'nsanenewz.com',
      'nsaneforums.com'
    ];

    log.debug({ query }, 'Software search initiated');

    try {
      const uniqueResults = await searchSearXng(query, this.searxngUrl, {
        trustedSites,
        generalQuerySuffix: 'crack OR patch OR keygen OR torrent OR download',
        maxResults: 15,
      });

      if (uniqueResults.length === 0) {
        return `No software downloads found for: "${query}".`;
      }

      const textResults = uniqueResults.map((item, idx) => {
        const itemUrl = item.url || '';
        const isTrusted = trustedSites.some((site) => itemUrl.includes(site));
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
