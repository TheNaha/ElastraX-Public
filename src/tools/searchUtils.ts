/**
 * @file src/tools/searchUtils.ts
 * @description Shared SearXNG search helper used by the game/software search tools.
 *
 * Centralises the previously-duplicated logic (URL normalisation, trusted-site
 * query construction, parallel fetches, JSON parsing, and URL de-duplication).
 */

import { logger } from '../utils/logger';

const log = logger.child({ module: 'searchUtils' });

export interface SearXngRawResult {
  url?: string;
  title?: string;
  content?: string;
  snippet?: string;
}

export interface SearXngSearchOptions {
  /** Sites constrained via `site:` in the "trusted" query. */
  trustedSites?: string[];
  /** Extra terms appended to the broad query (e.g. 'crack OR repack'). */
  generalQuerySuffix?: string;
  /** Maximum number of results to return (default 15). */
  maxResults?: number;
  /** Per-request timeout in ms (default 10000). */
  timeoutMs?: number;
}

function normalizeSearchUrl(base: string): string {
  let url = base.trim();
  if (!url.endsWith('/search') && !url.endsWith('/search/')) {
    url = url.endsWith('/') ? `${url}search` : `${url}/search`;
  }
  return url;
}

/**
 * Runs a SearXNG JSON search across a trusted-site-scoped query and a broader
 * query in parallel, merges and de-duplicates the results by URL, and returns
 * up to `maxResults` items.
 */
export async function searchSearXng(
  query: string,
  baseUrl: string,
  opts: SearXngSearchOptions = {},
): Promise<SearXngRawResult[]> {
  const {
    trustedSites = [],
    generalQuerySuffix = '',
    maxResults = 15,
    timeoutMs = 10000,
  } = opts;

  const siteQuery = trustedSites.map((s) => `site:${s}`).join(' OR ');
  const trustedQuery = siteQuery ? `${query} (${siteQuery})` : query;
  const generalQuery = generalQuerySuffix ? `${query} ${generalQuerySuffix}` : query;

  const buildUrl = (q: string): string => {
    const u = new URL(normalizeSearchUrl(baseUrl));
    u.search = new URLSearchParams({ q, format: 'json' }).toString();
    return u.toString();
  };

  const fetchOpts = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'X-Forwarded-For': '127.0.0.1',
      'X-Real-IP': '127.0.0.1',
    },
    signal:
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : (() => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), timeoutMs);
            return controller.signal;
          })(),
  };

  // A single-query tool (e.g. web_search without trusted sites/suffix) would
  // fire two identical requests — de-duplicate them.
  const requests = trustedQuery === generalQuery
    ? [fetch(buildUrl(trustedQuery), fetchOpts).catch(() => null)]
    : [
        fetch(buildUrl(trustedQuery), fetchOpts).catch(() => null),
        fetch(buildUrl(generalQuery), fetchOpts).catch(() => null),
      ];
  const responses = await Promise.all(requests);

  const all: SearXngRawResult[] = [];
  let anyOk = false;
  for (const res of responses) {
    if (res && res.ok) {
      anyOk = true;
      try {
        const data = (await res.json()) as { results?: SearXngRawResult[] };
        if (data.results) all.push(...data.results);
      } catch (err) {
        log.warn({ err }, 'Failed to parse SearXNG JSON response');
      }
    }
  }

  // Distinguish "instance unreachable / erroring" from "legitimately zero
  // hits" so callers can surface a failure instead of a false "no results".
  if (!anyOk) {
    throw new Error('SearXNG returned no successful response (unreachable or HTTP error)');
  }

  const seen = new Set<string>();
  const unique: SearXngRawResult[] = [];
  for (const r of all) {
    if (r.url && !seen.has(r.url)) {
      seen.add(r.url);
      unique.push(r);
    }
  }

  return unique.slice(0, maxResults);
}
