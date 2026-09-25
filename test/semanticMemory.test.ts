import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { createTempDatabase, type TempDatabase } from './helpers/database';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

type MemRow = { id: string; content: string; embedding?: Buffer | null; embeddingModel?: string | null; created_at: Date };

let memRows: MemRow[] = [];
let updateCalls: Record<string, unknown>[] = [];

// Bun module mocks are process-wide, so this fake must expose the full
// `../src/db` surface or every other test file importing the real module breaks.
const database: TempDatabase = createTempDatabase();

// Mirrors src/db/runtime.ts exactly: the return value must be propagated,
// because callers such as claimInboxEvents rely on it.
function withImmediateTransaction<T>(sqlite: TempDatabase['sqlite'], operation: () => T): T {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      sqlite.exec('ROLLBACK');
    } catch {
      // The transaction may already be rolled back; surface the original error.
    }
    throw error;
  }
}

function completeDb(overrides: Record<string, unknown>): unknown {
  const base = database.db as unknown as Record<string | symbol, unknown>;
  return new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === 'string' && property in overrides) return overrides[property];
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

mock.module('../src/db', () => ({
  db: completeDb({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              all: () => memRows,
            }),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          updateCalls.push(vals);
        },
      }),
    }),
  }),
  sqlite: database.sqlite,
  withImmediateTransaction,
}));

import { EmbeddingService } from '../src/utils/EmbeddingService';
import {
  cosineSimilarity,
  bytesToFloat32,
  float32ToBytes,
  updateMemoryEmbedding,
  findSemanticDuplicate,
  rankMemoriesForInjection,
} from '../src/utils/semanticMemory';

const V = (...xs: number[]) => new Float32Array(xs);

/** Stored vectors are only comparable when they come from the same embedding
 *  space (model + endpoint + dimension); the row must carry that space id. */
function spaceIdFor(dimension: number): string {
  return EmbeddingService.getCurrentSpace(dimension).id;
}

function memoryRow(
  id: string,
  content: string,
  vector: Float32Array | null,
  created_at: Date,
  spaceId = vector ? spaceIdFor(vector.length) : null,
): MemRow {
  return { id, content, embedding: vector ? float32ToBytes(vector) : null, embeddingModel: spaceId, created_at };
}

const setEnv = () => {
  process.env.EMBEDDING_API_URL = 'http://localhost:9999';
  process.env.EMBEDDING_MODEL = 'test-model';
};
const unsetEnv = () => {
  delete process.env.EMBEDDING_API_URL;
  delete process.env.EMBEDDING_MODEL;
};

beforeEach(() => {
  setEnv();
  memRows = [];
  updateCalls = [];
});

afterEach(() => {
  unsetEnv();
});

describe('cosineSimilarity', () => {
  test('identical vectors score 1', () => {
    expect(cosineSimilarity(V(1, 0, 2), V(1, 0, 2))).toBeCloseTo(1);
  });

  test('orthogonal vectors score 0', () => {
    expect(cosineSimilarity(V(1, 0), V(0, 1))).toBe(0);
  });

  test('opposite vectors score -1', () => {
    expect(cosineSimilarity(V(1, 0), V(-1, 0))).toBeCloseTo(-1);
  });

  test('length mismatch scores 0 (no crash)', () => {
    expect(cosineSimilarity(V(1, 2, 3), V(1, 2))).toBe(0);
  });

  test('zero vector scores 0 (denominator guard)', () => {
    expect(cosineSimilarity(V(0, 0), V(1, 1))).toBe(0);
  });

  test('accepts Buffer inputs via decode path', () => {
    const buf = float32ToBytes(V(0.5, 0.5));
    expect(cosineSimilarity(buf, V(0.5, 0.5))).toBeCloseTo(1);
  });
});

describe('float32 <-> bytes codecs', () => {
  test('round-trips values', () => {
    const original = V(1.5, -2.25, 0.125, 42);
    const decoded = bytesToFloat32(float32ToBytes(original));
    expect(Array.from(decoded)).toEqual([1.5, -2.25, 0.125, 42]);
  });
});

describe('updateMemoryEmbedding', () => {
  test('returns false when feature disabled', async () => {
    unsetEnv();
    let called = false;
    const ok = await updateMemoryEmbedding('m1', 'hello', { embed: async () => { called = true; return V(1); } });
    expect(ok).toBe(false);
    expect(called).toBe(false);
  });

  test('persists vector + embedding space id + timestamp when embed succeeds', async () => {
    const ok = await updateMemoryEmbedding('m1', 'hello', { embed: async () => V(0.25, 0.75) });
    expect(ok).toBe(true);
    expect(updateCalls).toHaveLength(1);
    const vals = updateCalls[0]!;
    // The stored fingerprint pins model + endpoint + dimension so vectors from
    // a different embedding space are never compared.
    expect(vals.embeddingModel).toBe(spaceIdFor(2));
    expect(vals.embedding).toBeInstanceOf(Buffer);
    expect(Array.from(bytesToFloat32(vals.embedding as Buffer))).toEqual([0.25, 0.75]);
    expect(vals.embeddedAt).toBeInstanceOf(Date);
  });

  test('returns false when embed yields nothing (never blocks caller)', async () => {
    const ok = await updateMemoryEmbedding('m1', 'hello', { embed: async () => null });
    expect(ok).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });
});

describe('findSemanticDuplicate', () => {
  test('disabled feature short-circuits to null without embedding', async () => {
    unsetEnv();
    let called = false;
    const hit = await findSemanticDuplicate('owner', 'hello', { embed: async () => { called = true; return V(1); } });
    expect(hit).toBeNull();
    expect(called).toBe(false);
  });

  test('detects near-identical stored memory above threshold', async () => {
    memRows = [memoryRow('m1', 'the wifi password is hunter2', V(1, 0), new Date())];
    const hit = await findSemanticDuplicate('owner', 'the wifi password is hunter2!', { embed: async () => V(1, 0) });
    expect(hit?.id).toBe('m1');
    expect(hit?.similarity).toBeCloseTo(1);
  });

  test('ignores vectors written by a different embedding space', async () => {
    memRows = [{
      id: 'm1',
      content: 'the wifi password is hunter2',
      embedding: float32ToBytes(V(1, 0)),
      embeddingModel: 'embedding-space:v1:someotherendpoint',
      created_at: new Date(),
    }];
    const hit = await findSemanticDuplicate('owner', 'the wifi password is hunter2!', { embed: async () => V(1, 0) });
    expect(hit).toBeNull();
  });

  test('ignores vectors whose dimension does not match the current space', async () => {
    memRows = [memoryRow('m1', 'stale vector', V(1, 0, 0), new Date())];
    const hit = await findSemanticDuplicate('owner', 'stale vector', { embed: async () => V(1, 0) });
    expect(hit).toBeNull();
  });

  test('unrelated content produces no duplicate', async () => {
    memRows = [memoryRow('m1', 'a', V(1, 0), new Date())];
    const hit = await findSemanticDuplicate('owner', 'b', { embed: async () => V(0, 1) });
    expect(hit).toBeNull();
  });

  test('embed failure degrades to null (insert allowed)', async () => {
    const hit = await findSemanticDuplicate('owner', 'hello', { embed: async () => { throw new Error('api down'); } });
    expect(hit).toBeNull();
  });
});

describe('rankMemoriesForInjection', () => {
  test('empty query falls back to recency (null)', async () => {
    const ranked = await rankMemoriesForInjection('owner', '   ', { embed: async () => V(1) });
    expect(ranked).toBeNull();
  });

  test('vectors from a foreign embedding space are not ranked', async () => {
    memRows = [{
      id: 'A',
      content: 'exact match',
      embedding: float32ToBytes(V(1, 0)),
      embeddingModel: 'embedding-space:v1:elsewhere',
      created_at: new Date(),
    }];
    const ranked = await rankMemoriesForInjection('owner', 'match me', { embed: async () => V(1, 0) }, 3);
    expect(ranked).toBeNull();
  });

  test('no embedded candidates falls back (null)', async () => {
    memRows = [];
    const ranked = await rankMemoriesForInjection('owner', 'hello', { embed: async () => V(1) });
    expect(ranked).toBeNull();
  });

  test('query embedding failure falls back (null)', async () => {
    memRows = [memoryRow('m1', 'a', V(1, 0), new Date())];
    const ranked = await rankMemoriesForInjection('owner', 'hello', { embed: async () => null });
    expect(ranked).toBeNull();
  });

  test('ranks semantic head above recency tail, output chronological', async () => {
    const t1 = new Date('2026-01-01');
    const t2 = new Date('2026-02-01');
    const t3 = new Date('2026-03-01');
    // DB order is newest-first (orderBy desc).
    memRows = [
      memoryRow('A', 'exact match', V(1, 0), t3),
      memoryRow('B', 'orthogonal', V(0, 1), t1),
      memoryRow('C', 'not yet embedded', null, t2),
    ];
    const ranked = await rankMemoriesForInjection('owner', 'match me', { embed: async () => V(1, 0) }, 3);
    // Semantic head A first, then recency tail B/C; display order oldest→newest.
    expect(ranked?.map(r => r.id)).toEqual(['B', 'C', 'A']);
  });

  test('maxMemories caps the selection keeping best matches', async () => {
    const t1 = new Date('2026-01-01');
    const t2 = new Date('2026-02-01');
    const t3 = new Date('2026-03-01');
    memRows = [
      memoryRow('A', 'exact match', V(1, 0), t3),
      memoryRow('B', 'orthogonal', V(0, 1), t1),
      memoryRow('C', 'not embedded', null, t2),
    ];
    const ranked = await rankMemoriesForInjection('owner', 'match me', { embed: async () => V(1, 0) }, 1);
    expect(ranked?.map(r => r.id)).toEqual(['A']);
  });
});
