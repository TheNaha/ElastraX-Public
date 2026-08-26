/**
 * @file src/utils/semanticMemory.ts
 * @description Semantic-memory helpers: cosine ranking for prompt injection,
 *              duplicate detection at write time, and embedding persistence.
 *
 * Strategy (no native extensions — Bun + loadable modules are risky, and a
 * household-scale corpus fits in memory trivially):
 *  1. Candidates: most recent EMBEDDING_CANDIDATES memories for the owner.
 *  2. Rank: cosine similarity between the query vector and each embedded
 *     candidate, computed in JS (Float32Array dot product).
 *  3. Fill: if fewer than MAX_INJECTED_MEMORIES score above zero, top up with
 *     the newest unembedded/unmatched memories so small corpora behave exactly
 *     like the old recency-only path.
 *
 * Every function degrades gracefully: without configuration, on API failure,
 * or with an empty corpus it returns null / no-op and callers fall back to
 * recency behavior.
 */

import { db } from '../db';
import { memories } from '../db/schema';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { logger } from './logger';
import { getErrorMessage } from './errorUtils';
import { EmbeddingService } from './EmbeddingService';
import { MAX_INJECTED_MEMORIES } from '../core/constants';

const log = logger.child({ module: 'SemanticMemory' });

/** Candidate pool scanned per injection (most recent N rows for the owner). */
export const CANDIDATE_POOL = Number(process.env.EMBEDDING_CANDIDATES ?? '') || 400;
/** Cosine threshold at which a new memory is considered a duplicate. */
export const DEDUPE_SIMILARITY_THRESHOLD = Number(process.env.EMBEDDING_DEDUPE_THRESHOLD ?? '') || 0.93;

export interface RankedMemory {
  id: string;
  content: string;
}

export interface SemanticMemoryDeps {
  embed?: (text: string) => Promise<Float32Array | null>;
}

/** Cosine similarity between two equal-length vectors. Returns 0 on mismatch/empty. */
export function cosineSimilarity(a: Float32Array | Buffer, b: Float32Array | Buffer): number {
  const fa = a instanceof Float32Array ? a : bytesToFloat32(a);
  const fb = b instanceof Float32Array ? b : bytesToFloat32(b);
  const n = Math.min(fa.length, fb.length);
  if (n === 0 || fa.length !== fb.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    dot += fa[i]! * fb[i]!;
    normA += fa[i]! * fa[i]!;
    normB += fb[i]! * fb[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Decode Float32 bytes stored in SQLite BLOB columns. */
export function bytesToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/** Encode a Float32Array for storage in a SQLite BLOB column. */
export function float32ToBytes(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Compute (and persist) the embedding for one memory row.
 * Returns true when a vector was stored. Never throws.
 */
export async function updateMemoryEmbedding(id: string, content: string, deps?: SemanticMemoryDeps): Promise<boolean> {
  const embed = deps?.embed ?? ((text: string) => EmbeddingService.tryEmbed(text));
  try {
    const model = process.env.EMBEDDING_MODEL?.trim();
    if (!model || !EmbeddingService.isEnabled()) return false;
    const vec = await embed(content);
    if (!vec || vec.length === 0) return false;
    await db.update(memories)
      .set({ embedding: float32ToBytes(vec), embeddingModel: model, embeddedAt: new Date() })
      .where(eq(memories.id, id));
    return true;
  } catch (error: unknown) {
    log.warn({ err: getErrorMessage(error), id }, '[SemanticMemory] Failed to persist embedding');
    return false;
  }
}

export interface DuplicateHit {
  id: string;
  content: string;
  similarity: number;
}

/**
 * Find an existing memory of this owner that is semantically identical to
 * `content` (cosine >= DEDUPE_SIMILARITY_THRESHOLD). Returns null when the
 * embeddings feature is off, the API fails, or nothing matches closely.
 */
export async function findSemanticDuplicate(ownerId: string, content: string, deps?: SemanticMemoryDeps): Promise<DuplicateHit | null> {
  if (!EmbeddingService.isEnabled()) return null;
  const embed = deps?.embed ?? ((text: string) => EmbeddingService.tryEmbed(text));

  try {
    const [queryVec] = await Promise.all([embed(content)]);
    if (!queryVec || queryVec.length === 0) return null;

    // Compare only against already-embedded rows of the same owner/model.
    const candidates = db.select({ id: memories.id, content: memories.content, embedding: memories.embedding })
      .from(memories)
      .where(and(eq(memories.ownerId, ownerId), isNotNull(memories.embedding)))
      .orderBy(desc(memories.created_at))
      .limit(CANDIDATE_POOL)
      .all();

    let best: DuplicateHit | null = null;
    for (const row of candidates) {
      if (!row.embedding) continue;
      const sim = cosineSimilarity(queryVec, row.embedding);
      if (sim >= DEDUPE_SIMILARITY_THRESHOLD && (!best || sim > best.similarity)) {
        best = { id: row.id, content: row.content, similarity: sim };
      }
    }
    return best;
  } catch (error: unknown) {
    log.warn({ err: getErrorMessage(error) }, '[SemanticMemory] Duplicate check failed — allowing insert');
    return null;
  }
}

/**
 * Rank the owner's memories by semantic similarity to `queryText`.
 *
 * Returns null when the caller should fall back to plain recency ordering
 * (feature disabled, empty query, API failure, or no embedded rows at all).
 * Otherwise returns up to `maxMemories` entries, semantically-ranked head +
 * recency tail, in chronological order for display.
 */
export async function rankMemoriesForInjection(
  ownerId: string,
  queryText: string,
  deps?: SemanticMemoryDeps,
  maxMemories: number = MAX_INJECTED_MEMORIES,
): Promise<RankedMemory[] | null> {
  const trimmedQuery = queryText?.trim();
  if (!trimmedQuery || !EmbeddingService.isEnabled()) return null;

  const embed = deps?.embed ?? ((text: string) => EmbeddingService.tryEmbed(text));

  try {
    const candidates = db.select({
      id: memories.id,
      content: memories.content,
      embedding: memories.embedding,
      created_at: memories.created_at,
    })
      .from(memories)
      .where(and(
        eq(memories.ownerId, ownerId),
        // Only compare against vectors produced by the currently configured model.
        eq(memories.embeddingModel, process.env.EMBEDDING_MODEL?.trim() ?? ''),
      ))
      .orderBy(desc(memories.created_at))
      .limit(CANDIDATE_POOL)
      .all();

    if (candidates.length === 0) return null;

    const queryVec = await embed(trimmedQuery);
    if (!queryVec || queryVec.length === 0) return null;

    const scored: { row: (typeof candidates)[number]; sim: number }[] = [];
    const unscored: typeof candidates = [];
    for (const row of candidates) {
      if (!row.embedding) {
        unscored.push(row);
        continue;
      }
      scored.push({ row, sim: cosineSimilarity(queryVec, row.embedding) });
    }

    // Semantic head: best matches first (ties broken by recency via stable sort input order).
    scored.sort((a, b) => b.sim - a.sim);
    const picked = scored.slice(0, maxMemories).map(s => s.row);

    // Recency tail: fill with newest rows not already picked so short
    // conversations keep full context coverage.
    const pickedIds = new Set(picked.map(r => r.id));
    for (const row of [...scored.slice(maxMemories).map(s => s.row), ...unscored]) {
      if (picked.length >= maxMemories) break;
      if (!pickedIds.has(row.id)) {
        picked.push(row);
        pickedIds.add(row.id);
      }
    }

    if (picked.length === 0) return null;

    log.debug({ ownerId, candidates: candidates.length, injected: picked.length }, '[SemanticMemory] Memories ranked');
    // Display order: oldest → newest of the selected set.
    return picked
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map(r => ({ id: r.id, content: r.content }));
  } catch (error: unknown) {
    log.warn({ err: getErrorMessage(error) }, '[SemanticMemory] Ranking failed — falling back to recency');
    return null;
  }
}
