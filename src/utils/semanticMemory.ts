import { db } from '../db';
import { memories } from '../db/schema';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { logger } from './logger';
import { getErrorMessage } from './errorUtils';
import { EmbeddingService, type EmbeddingSpace } from './EmbeddingService';
import { MAX_INJECTED_MEMORIES } from '../core/constants';

const log = logger.child({ module: 'SemanticMemory' });

function positiveEnvNumber(
  value: string | undefined,
  fallback: number,
  max: number,
  integer = true,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(integer ? Math.floor(parsed) : parsed, max);
}

export const CANDIDATE_POOL = positiveEnvNumber(process.env.EMBEDDING_CANDIDATES, 400, 10_000);
export const DEDUPE_SIMILARITY_THRESHOLD = positiveEnvNumber(
  process.env.EMBEDDING_DEDUPE_THRESHOLD,
  0.93,
  1,
  false,
);

export interface RankedMemory {
  id: string;
  content: string;
}

export interface SemanticMemoryDeps {
  embed?: (text: string) => Promise<Float32Array | null>;
}

export function cosineSimilarity(a: Float32Array | Buffer, b: Float32Array | Buffer): number {
  const fa = a instanceof Float32Array ? a : bytesToFloat32(a);
  const fb = b instanceof Float32Array ? b : bytesToFloat32(b);
  if (fa.length === 0 || fa.length !== fb.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < fa.length; i++) {
    dot += fa[i]! * fb[i]!;
    normA += fa[i]! * fa[i]!;
    normB += fb[i]! * fb[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function bytesToFloat32(buf: Buffer): Float32Array {
  if (buf.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return new Float32Array(0);
  return new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
}

export function float32ToBytes(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

async function embedInCurrentSpace(
  text: string,
  embed: (value: string) => Promise<Float32Array | null>,
): Promise<{ vector: Float32Array; space: EmbeddingSpace } | null> {
  const vector = await embed(text);
  if (!vector || vector.length === 0) return null;
  return { vector, space: EmbeddingService.getCurrentSpace(vector.length) };
}

function vectorMatchesSpace(embedding: Buffer, space: EmbeddingSpace): Float32Array | null {
  if (embedding.byteLength !== space.dimension * Float32Array.BYTES_PER_ELEMENT) return null;
  return bytesToFloat32(embedding);
}

export async function updateMemoryEmbedding(
  id: string,
  content: string,
  deps?: SemanticMemoryDeps,
): Promise<boolean> {
  const embed = deps?.embed ?? ((text: string) => EmbeddingService.tryEmbed(text));
  try {
    if (!EmbeddingService.isEnabled()) return false;
    const embedded = await embedInCurrentSpace(content, embed);
    if (!embedded) return false;
    await db.update(memories)
      .set({
        embedding: float32ToBytes(embedded.vector),
        embeddingModel: embedded.space.id,
        embeddedAt: new Date(),
      })
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

export async function findSemanticDuplicate(
  ownerId: string,
  content: string,
  deps?: SemanticMemoryDeps,
): Promise<DuplicateHit | null> {
  if (!EmbeddingService.isEnabled()) return null;
  const embed = deps?.embed ?? ((text: string) => EmbeddingService.tryEmbed(text));

  try {
    const embedded = await embedInCurrentSpace(content, embed);
    if (!embedded) return null;
    const candidates = db.select({
      id: memories.id,
      content: memories.content,
      embedding: memories.embedding,
      embeddingModel: memories.embeddingModel,
    })
      .from(memories)
      .where(and(
        eq(memories.ownerId, ownerId),
        isNotNull(memories.embedding),
        eq(memories.embeddingModel, embedded.space.id),
      ))
      .orderBy(desc(memories.created_at))
      .limit(CANDIDATE_POOL)
      .all();

    let best: DuplicateHit | null = null;
    for (const row of candidates) {
      if (!row.embedding || row.embeddingModel !== embedded.space.id) continue;
      const vector = vectorMatchesSpace(row.embedding, embedded.space);
      if (!vector) continue;
      const similarity = cosineSimilarity(embedded.vector, vector);
      if (similarity >= DEDUPE_SIMILARITY_THRESHOLD && (!best || similarity > best.similarity)) {
        best = { id: row.id, content: row.content, similarity };
      }
    }
    return best;
  } catch (error: unknown) {
    log.warn({ err: getErrorMessage(error) }, '[SemanticMemory] Duplicate check failed — allowing insert');
    return null;
  }
}

export async function rankMemoriesForInjection(
  ownerId: string,
  queryText: string,
  deps?: SemanticMemoryDeps,
  maxMemories: number = MAX_INJECTED_MEMORIES,
): Promise<RankedMemory[] | null> {
  const trimmedQuery = queryText?.trim();
  if (!trimmedQuery || !EmbeddingService.isEnabled()) return null;
  const limit = Number.isFinite(maxMemories) ? Math.max(0, Math.floor(maxMemories)) : MAX_INJECTED_MEMORIES;
  if (limit === 0) return [];
  const embed = deps?.embed ?? ((text: string) => EmbeddingService.tryEmbed(text));

  try {
    const candidates = db.select({
      id: memories.id,
      content: memories.content,
      embedding: memories.embedding,
      embeddingModel: memories.embeddingModel,
      created_at: memories.created_at,
    })
      .from(memories)
      .where(eq(memories.ownerId, ownerId))
      .orderBy(desc(memories.created_at))
      .limit(CANDIDATE_POOL)
      .all();
    if (candidates.length === 0) return null;

    const embedded = await embedInCurrentSpace(trimmedQuery, embed);
    if (!embedded) return null;

    const scored: { row: (typeof candidates)[number]; similarity: number }[] = [];
    const recencyTail: typeof candidates = [];
    for (const row of candidates) {
      if (!row.embedding || row.embeddingModel !== embedded.space.id) {
        if (!row.embedding) recencyTail.push(row);
        continue;
      }
      const vector = vectorMatchesSpace(row.embedding, embedded.space);
      if (vector) scored.push({ row, similarity: cosineSimilarity(embedded.vector, vector) });
    }
    if (scored.length === 0) return null;

    scored.sort((a, b) => b.similarity - a.similarity);
    const picked = scored.slice(0, limit).map(scoredRow => scoredRow.row);
    const pickedIds = new Set(picked.map(row => row.id));
    for (const row of [...scored.slice(limit).map(scoredRow => scoredRow.row), ...recencyTail]) {
      if (picked.length >= limit) break;
      if (!pickedIds.has(row.id)) {
        picked.push(row);
        pickedIds.add(row.id);
      }
    }
    if (picked.length === 0) return null;

    log.debug({ ownerId, candidates: candidates.length, injected: picked.length }, '[SemanticMemory] Memories ranked');
    return picked
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map(row => ({ id: row.id, content: row.content }));
  } catch (error: unknown) {
    log.warn({ err: getErrorMessage(error) }, '[SemanticMemory] Ranking failed — falling back to recency');
    return null;
  }
}
