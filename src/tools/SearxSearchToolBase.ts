/**
 * @file src/tools/SearxSearchToolBase.ts
 * @description Shared execution pipeline for SearXNG-backed search tools
 * (web_search, game_search, software_search): argument guards, env guard,
 * protocol check, search invocation, and result formatting skeleton.
 * Subclasses only declare identity (name/aliases/triggers) and the small
 * formatting hooks that genuinely differ.
 */

import { BaseTool, type ToolArgs, type ToolDefinition } from './BaseTool';
import type { MessageContext } from '../core/MessageContext';
import { logger } from '../utils/logger';
import { searchSearXng, type SearXngRawResult } from './searchUtils';
import { t } from '../utils/i18n';

const log = logger.child({ module: 'SearxSearchToolBase' });

export type SearchToolArgs = ToolArgs & { query?: string };

export abstract class SearxSearchToolBase extends BaseTool<SearchToolArgs> {
  /** Subclasses set these instead of duplicating the execute() pipeline. */
  protected readonly searxngUrl: string;
  protected readonly trustedSites: string[] = [];
  protected readonly generalQuerySuffix: string = '';
  protected readonly maxResults: number = 15;
  protected abstract readonly queryParamDescription: string;

  protected constructor() {
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
              description: this.queryParamDescription,
            },
          },
          required: ['query'],
        },
      },
    };
  }

  async execute(args: SearchToolArgs, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    const query = args.query;
    if (!query) return t(lang, 'search.query_missing');
    if (!this.searxngUrl) return this.missingConfigMessage(lang);

    let baseUrl: URL;
    try {
      baseUrl = new URL(this.searxngUrl);
      if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
        throw new Error(`Invalid protocol for SEARXNG_URL: ${baseUrl.protocol}. Must be http: or https:`);
      }
    } catch (err) {
      log.error({ err, url: this.searxngUrl }, 'Invalid SEARXNG_URL');
      return this.failureMessage(lang, query);
    }

    log.debug({ query }, `${this.name} initiated`);

    try {
      const results = await searchSearXng(query, this.searxngUrl, {
        trustedSites: this.trustedSites,
        generalQuerySuffix: this.generalQuerySuffix,
        maxResults: this.maxResults,
      });
      if (results.length === 0) return this.noResultsMessage(lang, query);
      return this.formatResults(lang, results, query);
    } catch (err) {
      log.error({ err, query }, `${this.name} failed`);
      return this.failureMessage(lang, query);
    }
  }

  /**
   * Default formatting shared by game/software search: numbered list with a
   * TRUSTED/UNTRUSTED tag per result based on {@link trustedSites}.
   */
  protected formatResults(lang: string, results: SearXngRawResult[], query: string): string {
    const textResults = results.map((item, idx) => {
      const itemUrl = item.url || '';
      const isTrusted = this.trustedSites.some((site) => itemUrl.includes(site));
      const status = isTrusted ? t(lang, 'search.trusted') : t(lang, 'search.untrusted');
      return ` • *[${idx + 1}] ${status} ${item.title || t(lang, 'search.unknown')}*\n   *URL:* ${itemUrl}\n   *Info:* ${item.content || item.snippet || ''}`;
    }).join('\n\n');
    return `${this.resultsHeader(lang, query)}\n\n${textResults}`;
  }

  protected abstract resultsHeader(lang: string, query: string): string;
  protected abstract noResultsMessage(lang: string, query: string): string;
  protected abstract failureMessage(lang: string, query: string): string;

  protected missingConfigMessage(lang: string): string {
    return t(lang, 'search.searxng_not_configured');
  }
}
