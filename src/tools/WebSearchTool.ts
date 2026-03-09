/**
 * @file src/tools/WebSearchTool.ts
 * @description Web search tool powered by a self-hosted SearXNG instance.
 *
 * When the LLM determines that a user question requires up-to-date or factual
 * information it calls this tool with a search query.  The tool queries the
 * configured SearXNG instance (default: `SEARXNG_URL` env var), retrieves the
 * top-5 results, and returns a structured text snippet that the LLM can
 * summarise for the user.
 *
 * Configuration:
 *  - `SEARXNG_URL` — Base URL of the SearXNG instance (e.g., https://searx.example.com).
 *    Falls back to the bundled private instance if not set.
 *
 * Slash command aliases: `/search`, `/google`, `/duckduckgo`
 */

import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'WebSearchTool' });
type WebSearchArgs = ToolArgs & {
  query?: string;
};
type SearchResult = {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
};
type SearchResponse = {
  results?: SearchResult[];
};

export class WebSearchTool extends BaseTool<WebSearchArgs> {
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

  async execute(args: WebSearchArgs, _ctx: MessageContext): Promise<string> {
    const query = args.query;
    if (!query) return 'Error: query parameter is missing.';

    log.debug({ query }, 'Web search initiated');

    try {
      const baseUrl = this.searxngUrl.endsWith('/') ? this.searxngUrl : `${this.searxngUrl}/`;
      const url = new URL(baseUrl);

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Invalid protocol for SEARXNG_URL: ${url.protocol}. Must be http: or https:`);
      }
      
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

      const data = await response.json() as SearchResponse;
      
      if (!data.results || data.results.length === 0) {
        log.debug({ query }, 'No search results found');
        return `No results found on the web for: ${query}`;
      }

      log.debug({ query, resultCount: data.results.length }, 'Search results received');

      // Format the top 5 results for the LLM context
      const textResults = data.results.slice(0, 5).map((item, idx) => {
        return `[${idx + 1}] Title: ${item.title || ''}\nURL: ${item.url || ''}\nExcerpt: ${item.content || item.snippet || ''}\n`;
      }).join('\n');

      return `Search results for "${query}":\n\n${textResults}`;
    } catch (err) {
      log.error({ err, query }, 'Web search failed');
      return `Failed to search the web for "${query}" due to an internal error. Make sure the SearXNG instance is reachable.`;
    }
  }
}
