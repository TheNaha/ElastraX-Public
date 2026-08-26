/**
 * @file src/tools/WebSearchTool.ts
 * @description Web search tool powered by a self-hosted SearXNG instance.
 *
 * When the LLM determines that a user question requires up-to-date or factual
 * information it calls this tool with a search query.  The tool queries the
 * configured SearXNG instance (`SEARXNG_URL` env var), retrieves the top-5
 * results, and returns a structured text snippet that the LLM can summarise.
 *
 * Slash command aliases: `/search`, `/google`, `/duckduckgo`
 */

import { SearxSearchToolBase } from './SearxSearchToolBase';
import type { SearXngRawResult } from './searchUtils';

const esc = (s: string) => s.replace(/([*`_[\]\\])/g, '\\$1');

export class WebSearchTool extends SearxSearchToolBase {
  readonly name = 'web_search';
  readonly description = 'Search the web for current information, facts, or news.';
  readonly aliases = ['search', 'google', 'duckduckgo'];
  readonly category = 'utility';
  readonly permissions = 'user';
  override readonly alwaysLoad = true;

  protected override readonly queryParamDescription =
    'The search query to look up on the web.';

  protected override readonly maxResults = 5;

  constructor() {
    super();
  }

  /** Plain web search: no trusted-site tagging, markdown-escaped output. */
  protected override formatResults(results: SearXngRawResult[], query: string): string {
    const textResults = results.map((item, idx) => {
      return ` • *[${idx + 1}] Title:* ${item.title || ''}\n   *URL:* ${item.url || ''}\n   *Excerpt:* ${item.content || item.snippet || ''}`;
    }).join('\n\n');
    return `${this.resultsHeader(query)}\n\n${textResults}`;
  }

  protected override resultsHeader(query: string): string {
    return `Search results for "${esc(query)}":`;
  }

  protected override noResultsMessage(query: string): string {
    return `No results found on the web for: ${esc(query)}`;
  }

  protected override failureMessage(query: string): string {
    return `Failed to search the web for "${esc(query)}" due to an internal error. Make sure the SearXNG instance is reachable.`;
  }

  protected override missingConfigMessage(): string {
    return 'Error: SEARXNG_URL environment variable is not configured. Web search is unavailable.';
  }
}
