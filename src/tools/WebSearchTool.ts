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
import { t } from '../utils/i18n';

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
  protected override formatResults(lang: string, results: SearXngRawResult[], query: string): string {
    const textResults = results.map((item, idx) => {
      return ` • *[${idx + 1}] Title:* ${item.title || ''}\n   *URL:* ${item.url || ''}\n   *Excerpt:* ${item.content || item.snippet || ''}`;
    }).join('\n\n');
    return `${this.resultsHeader(lang, query)}\n\n${textResults}`;
  }

  protected override resultsHeader(lang: string, query: string): string {
    return t(lang, 'search.web.header', { query });
  }

  protected override noResultsMessage(lang: string, query: string): string {
    return t(lang, 'search.web.no_results', { query });
  }

  protected override failureMessage(lang: string, query: string): string {
    return t(lang, 'search.web.failed', { query });
  }

  protected override missingConfigMessage(lang: string): string {
    return t(lang, 'search.searxng_not_configured');
  }
}
