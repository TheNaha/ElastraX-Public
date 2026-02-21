import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';

export class WebSearchTool extends BaseTool {
  readonly name = 'web_search';
  readonly description = 'Searches the web for up-to-date information. Use this whenever you need to look up facts, news, or answer questions that require recent knowledge.';
  readonly aliases = ['search', 'google', 'duckduckgo'];
  readonly category = 'utility';
  readonly permissions = 'user';

  private readonly searxngUrl: string;

  constructor() {
    super();
    // Default to the provided SearXNG instance if not in env
    this.searxngUrl = process.env.SEARXNG_URL || 'https://your-searxng-instance.example.com';
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
              description: 'The search query to look up on the web.',
            },
          },
          required: ['query'],
        },
      },
    };
  }

  async execute(args: Record<string, any>, _ctx: MessageContext): Promise<string> {
    const query = args.query;
    if (!query) return 'Error: query parameter is missing.';

    try {
      const baseUrl = this.searxngUrl.endsWith('/') ? this.searxngUrl : `${this.searxngUrl}/`;
      const url = new URL(baseUrl);
      
      const params = new URLSearchParams({
        q: query,
        format: 'json',
      });
      url.search = params.toString();

      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`SearXNG returned HTTP ${response.status}`);
      }

      const data = await response.json();
      
      if (!data.results || data.results.length === 0) {
        return `No results found on the web for: ${query}`;
      }

      // Format the top 5 results for the LLM context
      const textResults = data.results.slice(0, 5).map((item: any, idx: number) => {
        return `[${idx+1}] Title: ${item.title}\nURL: ${item.url}\nExcerpt: ${item.content || item.snippet || ''}\n`;
      }).join('\n');

      return `Search results for "${query}":\n\n${textResults}`;
    } catch (err) {
      logger.error(err, 'WebSearchTool failed');
      return `Failed to search the web for "${query}" due to an internal error. Make sure the SearXNG instance is reachable.`;
    }
  }
}
