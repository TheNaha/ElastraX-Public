import { createHash } from 'crypto';
import { logger } from './logger';
import { getErrorMessage } from './errorUtils';

const log = logger.child({ module: 'EmbeddingService' });
const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_MS = 10 * 60_000;
const SPACE_PREFIX = 'embedding-space:v1:';

export const MAX_BATCH_SIZE = 32;

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  dimension?: number;
}

export interface EmbeddingSpace {
  id: string;
  model: string;
  endpoint: string;
  dimension: number;
}

interface CacheEntry {
  vector: Float32Array;
  expiresAt: number;
}

interface RawEmbeddingItem {
  index?: unknown;
  embedding?: unknown;
}

function resolveEndpoint(rawUrl: string): string {
  const url = rawUrl.trim().replace(/\/+$/, '');
  if (url.endsWith('/embeddings')) return url;
  if (/\/v\d+$/.test(url)) return `${url}/embeddings`;
  return `${url}/v1/embeddings`;
}

function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

export function createEmbeddingSpaceId(model: string, endpoint: string, dimension: number): string {
  if (!model.trim()) throw new TypeError('Embedding model must be non-empty.');
  if (!Number.isInteger(dimension) || dimension < 1) {
    throw new TypeError('Embedding dimension must be a positive integer.');
  }
  const identity = JSON.stringify([model.trim(), endpointHash(resolveEndpoint(endpoint)), dimension]);
  return `${SPACE_PREFIX}${Buffer.from(identity, 'utf8').toString('base64url')}`;
}

export function parseEmbeddingSpaceId(value: string): EmbeddingSpace | null {
  if (!value.startsWith(SPACE_PREFIX)) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(value.slice(SPACE_PREFIX.length), 'base64url').toString('utf8'),
    ) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 3) return null;
    const [model, hash, dimension] = decoded;
    if (typeof model !== 'string' || typeof hash !== 'string') return null;
    if (!Number.isInteger(dimension) || (dimension as number) < 1) return null;
    return {
      id: value,
      model,
      endpoint: `sha256:${hash}`,
      dimension: dimension as number,
    };
  } catch {
    return null;
  }
}

function readDimension(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export class EmbeddingService {
  private static cache = new Map<string, CacheEntry>();
  private static inFlight = new Map<string, Promise<Float32Array[]>>();
  private static knownDimensions = new Map<string, number>();

  static isEnabled(): boolean {
    return this.readConfig() !== null;
  }

  static readConfig(): EmbeddingConfig | null {
    const baseUrl = process.env.EMBEDDING_API_URL?.trim() || undefined;
    const apiKey = process.env.EMBEDDING_API_KEY?.trim() || undefined;
    const model = process.env.EMBEDDING_MODEL?.trim() || undefined;
    const timeoutRaw = Number.parseInt(process.env.EMBEDDING_TIMEOUT_MS ?? '', 10);
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 8_000;
    const dimension = readDimension(process.env.EMBEDDING_DIMENSION);
    if (!baseUrl || !model) return null;
    return { baseUrl, apiKey, model, timeoutMs, dimension };
  }

  static getCurrentSpace(dimension?: number): EmbeddingSpace {
    const config = this.readConfig();
    if (!config) throw new Error('EmbeddingService is not configured.');
    const endpoint = resolveEndpoint(config.baseUrl);
    const key = `${config.model}\u0000${endpoint}`;
    const resolvedDimension = dimension ?? config.dimension ?? this.knownDimensions.get(key);
    if (!resolvedDimension) {
      throw new Error('Embedding dimension is not known yet.');
    }
    return {
      id: createEmbeddingSpaceId(config.model, config.baseUrl, resolvedDimension),
      model: config.model,
      endpoint,
      dimension: resolvedDimension,
    };
  }

  private static baseKey(config: EmbeddingConfig): string {
    return `${config.model}\u0000${resolveEndpoint(config.baseUrl)}`;
  }

  private static cacheKey(spaceId: string, text: string): string {
    return createHash('sha1').update(`${spaceId}\u0000${text}`).digest('hex');
  }

  static cacheGet(spaceId: string, text: string): Float32Array | undefined {
    const key = this.cacheKey(spaceId, text);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.vector;
  }

  static cacheSet(spaceId: string, text: string, vector: Float32Array): void {
    const key = this.cacheKey(spaceId, text);
    while (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { vector, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  private static async fetchBatch(
    config: EmbeddingConfig,
    texts: string[],
    expectedDimension: number | undefined,
  ): Promise<Float32Array[]> {
    const response = await fetch(resolveEndpoint(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: texts }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Embeddings API responded ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const json = await response.json() as unknown;
    const data = typeof json === 'object' && json !== null && 'data' in json
      ? (json as { data?: unknown }).data
      : null;
    const items = Array.isArray(data) ? data : null;
    if (!items || items.length !== texts.length) {
      throw new Error(`Embeddings API returned ${items?.length ?? 0} items for ${texts.length} inputs.`);
    }

    let dimension = expectedDimension;
    const results = new Array<Float32Array>(texts.length);
    const seen = new Set<number>();
    for (const raw of items as RawEmbeddingItem[]) {
      if (typeof raw !== 'object' || raw === null) {
        throw new Error('Embeddings API returned an invalid data item.');
      }
      if (!Number.isInteger(raw.index) || (raw.index as number) < 0 || (raw.index as number) >= texts.length) {
        throw new Error('Embeddings API returned an invalid response index.');
      }
      const index = raw.index as number;
      if (seen.has(index)) throw new Error('Embeddings API returned a duplicate response index.');
      seen.add(index);
      if (!Array.isArray(raw.embedding) || raw.embedding.length === 0) {
        throw new Error('Embeddings API returned an empty embedding vector.');
      }
      if (!raw.embedding.every(value => typeof value === 'number' && Number.isFinite(value))) {
        throw new Error('Embeddings API returned a non-finite embedding value.');
      }
      const vector = Float32Array.from(raw.embedding);
      if (!vector.every(value => Number.isFinite(value))) {
        throw new Error('Embeddings API returned a value outside the float32 range.');
      }
      if (dimension === undefined) dimension = vector.length;
      if (vector.length !== dimension) {
        throw new Error(`Embeddings API dimension mismatch: expected ${dimension}, received ${vector.length}.`);
      }
      results[index] = vector;
    }
    if (seen.size !== texts.length || results.some(vector => vector === undefined)) {
      throw new Error('Embeddings API response indices are incomplete.');
    }

    const actualDimension = results[0]!.length;
    this.knownDimensions.set(this.baseKey(config), actualDimension);
    return results;
  }

  static async embed(texts: string[]): Promise<Float32Array[]> {
    const config = this.readConfig();
    if (!config) {
      throw new Error('EmbeddingService is not configured (set EMBEDDING_API_URL and EMBEDDING_MODEL).');
    }
    if (texts.length === 0) return [];

    const knownDimension = config.dimension ?? this.knownDimensions.get(this.baseKey(config));
    const cacheSpaceId = knownDimension ? createEmbeddingSpaceId(config.model, config.baseUrl, knownDimension) : null;
    const results = new Array<Float32Array | undefined>(texts.length).fill(undefined);
    const uniquePending: Array<{ text: string; indexes: number[] }> = [];
    const byText = new Map<string, { text: string; indexes: number[] }>();

    texts.forEach((text, index) => {
      if (!text.trim()) return;
      if (cacheSpaceId) {
        const cached = this.cacheGet(cacheSpaceId, text);
        if (cached) {
          results[index] = cached;
          return;
        }
      }
      const pending = byText.get(text);
      if (pending) pending.indexes.push(index);
      else {
        const created = { text, indexes: [index] };
        byText.set(text, created);
        uniquePending.push(created);
      }
    });

    for (let start = 0; start < uniquePending.length; start += MAX_BATCH_SIZE) {
      const batch = uniquePending.slice(start, start + MAX_BATCH_SIZE);
      const batchTexts = batch.map(item => item.text);
      const requestKey = createHash('sha1')
        .update(`${this.baseKey(config)}\u0000${JSON.stringify(batchTexts)}`)
        .digest('hex');
      let request = this.inFlight.get(requestKey);
      if (!request) {
        request = this.fetchBatch(config, batchTexts, knownDimension);
        this.inFlight.set(requestKey, request);
      }

      let vectors: Float32Array[];
      try {
        vectors = await request;
      } finally {
        if (this.inFlight.get(requestKey) === request) this.inFlight.delete(requestKey);
      }

      const dimension = vectors[0]?.length ?? knownDimension;
      if (!dimension) throw new Error('Embeddings API returned an empty batch.');
      const spaceId = createEmbeddingSpaceId(config.model, config.baseUrl, dimension);
      batch.forEach((item, position) => {
        const vector = vectors[position]!;
        item.indexes.forEach(index => {
          results[index] = vector;
        });
        this.cacheSet(spaceId, item.text, vector);
      });
    }

    return results.map(result => result ?? new Float32Array(0));
  }

  static async tryEmbed(text: string): Promise<Float32Array | null> {
    try {
      const [vector] = await this.embed([text]);
      return vector && vector.length > 0 ? vector : null;
    } catch (error: unknown) {
      log.warn({ err: getErrorMessage(error) }, '[EmbeddingService] Embed failed — semantic features degrade to recency');
      return null;
    }
  }

  static clearCache(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.knownDimensions.clear();
  }
}
