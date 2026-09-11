/**
 * @file src/utils/EmbeddingService.ts
 * @description Client for any OpenAI-compatible embeddings endpoint.
 *
 * Used by the semantic-memory layer to embed memory texts and the current
 * conversation turn so memories can be ranked by cosine similarity instead of
 * pure recency.
 *
 * Configuration (all optional — when URL or model is missing the feature is
 * disabled and every caller falls back to recency-based behavior):
 *   EMBEDDING_API_URL     Base URL of an OpenAI-compatible API.
 *                         Accepted forms (resolved in order):
 *                           https://host/v1/embeddings  → used as-is
 *                           https://host/v1             → /embeddings appended
 *                           https://host                → /v1/embeddings appended
 *   EMBEDDING_API_KEY     Bearer token (omit for local/no-auth endpoints)
 *   EMBEDDING_MODEL       Model name, e.g. text-embedding-3-small / bge-m3
 *   EMBEDDING_TIMEOUT_MS  Per-request timeout (default 8000)
 *
 * Design notes:
 *  - Never throws into the caller's flow: `tryEmbed` returns null on any
 *    failure so message handling degrades gracefully.
 *  - A small TTL+LRU cache avoids re-embedding identical texts (quoted-message
 *    retries, repeated short queries).
 */

import { createHash } from 'crypto';
import { logger } from './logger';
import { getErrorMessage } from './errorUtils';

const log = logger.child({ module: 'EmbeddingService' });

const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_MS = 10 * 60_000;
/** Batch cap — keeps request bodies small and provider limits happy. */
export const MAX_BATCH_SIZE = 32;

interface CacheEntry {
  vector: Float32Array;
  expiresAt: number;
}

function resolveEndpoint(rawUrl: string): string {
  const url = rawUrl.trim().replace(/\/+$/, '');
  if (url.endsWith('/embeddings')) return url;
  if (/\/v\d+$/.test(url)) return `${url}/embeddings`;
  return `${url}/v1/embeddings`;
}

export class EmbeddingService {
  private static cache = new Map<string, CacheEntry>();

  /** True when both a base URL and a model are configured. */
  static isEnabled(): boolean {
    const cfg = this.readConfig();
    return !!(cfg && cfg.baseUrl && cfg.model);
  }

  static readConfig(): { baseUrl?: string; apiKey?: string; model?: string; timeoutMs: number } | null {
    const baseUrl = process.env.EMBEDDING_API_URL?.trim() || undefined;
    const apiKey = process.env.EMBEDDING_API_KEY?.trim() || undefined;
    const model = process.env.EMBEDDING_MODEL?.trim() || undefined;
    const timeoutRaw = parseInt(process.env.EMBEDDING_TIMEOUT_MS ?? '', 10);
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 8_000;
    if (!baseUrl || !model) return null;
    return { baseUrl, apiKey, model, timeoutMs };
  }

  private static cacheKey(model: string, text: string): string {
    return createHash('sha1').update(`${model}\u0000${text}`).digest('hex');
  }

  static cacheGet(model: string, text: string): Float32Array | undefined {
    const entry = this.cache.get(this.cacheKey(model, text));
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(this.cacheKey(model, text));
      return undefined;
    }
    // LRU refresh
    this.cache.delete(this.cacheKey(model, text));
    this.cache.set(this.cacheKey(model, text), entry);
    return entry.vector;
  }

  static cacheSet(model: string, text: string, vector: Float32Array): void {
    const key = this.cacheKey(model, text);
    while (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Map preserves insertion order → first key is least-recently-used.
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { vector, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  /**
   * Embed a batch of texts. Returns vectors in input order.
   * Throws on failure (use tryEmbed for the tolerant variant).
   */
  static async embed(texts: string[]): Promise<Float32Array[]> {
    const cfg = this.readConfig();
    if (!cfg || !cfg.model) throw new Error('EmbeddingService is not configured (set EMBEDDING_API_URL and EMBEDDING_MODEL)');
    if (texts.length === 0) return [];

    const results = new Array<Float32Array | undefined>(texts.length).fill(undefined);
    const pending: number[] = [];

    texts.forEach((text, i) => {
      if (!text.trim()) return; // leave undefined → empty vector below
      const cached = this.cacheGet(cfg.model!, text);
      if (cached) results[i] = cached;
      else pending.push(i);
    });

    for (let start = 0; start < pending.length; start += MAX_BATCH_SIZE) {
      const batchIdx = pending.slice(start, start + MAX_BATCH_SIZE);
      const batchTexts = batchIdx.map(i => texts[i]);

      const response = await fetch(resolveEndpoint(cfg.baseUrl!), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: cfg.model, input: batchTexts }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Embeddings API responded ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const json = (await response.json()) as { data?: { index?: number; embedding?: number[] }[] };
      if (!Array.isArray(json.data) || json.data.length === 0) {
        throw new Error('Embeddings API returned no data');
      }

      // OpenAI spec returns data sorted by index; sort defensively anyway.
      const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      sorted.forEach((item, pos) => {
        if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
          throw new Error('Embeddings API returned an empty embedding vector');
        }
        const target = batchIdx[pos] ?? batchIdx[0];
        const vec = Float32Array.from(item.embedding);
        results[target] = vec;
        this.cacheSet(cfg.model!, texts[target], vec);
      });
    }

    return results.map(r => r ?? new Float32Array(0));
  }

  /** Failure-tolerant single-text embed. Returns null instead of throwing. */
  static async tryEmbed(text: string): Promise<Float32Array | null> {
    try {
      const [vec] = await this.embed([text]);
      return vec && vec.length > 0 ? vec : null;
    } catch (error: unknown) {
      log.warn({ err: getErrorMessage(error) }, '[EmbeddingService] Embed failed — semantic features degrade to recency');
      return null;
    }
  }

  /** Test helper: wipe the in-memory cache. */
  static clearCache(): void {
    this.cache.clear();
  }
}
