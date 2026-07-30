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
 *    Required; tool is unavailable if not set.
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
  readonly description = 'Search the web for current information, facts, or news.';
  readonly aliases = ['search', 'google', 'duckduckgo'];
  readonly category = 'utility';
  readonly permissions = 'user';
  override readonly alwaysLoad = true;

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
    if (!this.searxngUrl) return 'Error: SEARXNG_URL environment variable is not configured. Web search is unavailable.';

    log.debug({ query }, 'Web search initiated');

    try {
      let baseUrl = this.searxngUrl;
      if (!baseUrl.endsWith('/search') && !baseUrl.endsWith('/search/')) {
        baseUrl = baseUrl.endsWith('/') ? baseUrl + 'search' : baseUrl + '/search';
      }
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
          'X-Forwarded-For': '127.0.0.1',
          'X-Real-IP': '127.0.0.1'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`SearXNG returned HTTP ${response.status}`);
      }

      const rawText = await response.text();
      let data: SearchResponse;
      try {
        data = JSON.parse(rawText) as SearchResponse;
      } catch (parseErr) {
        log.error({ query, parseErr, snippet: rawText.slice(0, 200) }, 'SearXNG returned non-JSON response');
        throw new Error('Received invalid JSON from search provider. It might be rate-limiting or returning HTML.');
      }
      
      if (!data.results || data.results.length === 0) {
        log.debug({ query }, 'No search results found');
        return `No results found on the web for: ${query}`;
      }

      log.debug({ query, resultCount: data.results.length }, 'Search results received');

      // Format the top 5 results for the LLM context
      const textResults = data.results.slice(0, 5).map((item, idx) => {
        return ` • *[${idx + 1}] Title:* ${item.title || ''}\n   *URL:* ${item.url || ''}\n   *Excerpt:* ${item.content || item.snippet || ''}`;
      }).join('\n\n');

      return `Search results for "${query}":\n\n${textResults}`;
    } catch (err) {
      log.error({ err, query }, 'Web search failed');
      return `Failed to search the web for "${query}" due to an internal error. Make sure the SearXNG instance is reachable.`;
    }
  }
}
