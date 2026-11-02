import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { db } from '../src/db';
import { memories } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { EmbeddingService } from '../src/utils/EmbeddingService';
import {
  bytesToFloat32,
  float32ToBytes,
  findSemanticDuplicate,
  rankMemoriesForInjection,
  updateMemoryEmbedding,
} from '../src/utils/semanticMemory';

type MemRow = {
  id: string;
  content: string;
  embedding: Buffer | null;
  embeddingModel: string | null;
  created_at: Date;
};

const V = (...values: number[]): Float32Array => Float32Array.from(values);

function spaceIdFor(dimension: number): string {
  return EmbeddingService.getCurrentSpace(dimension).id;
}

function memoryRow(
  id: string,
  content: string,
  embedding: Float32Array | null,
  created_at: Date,
): MemRow {
  return {
    id,
    content,
    embedding: embedding ? float32ToBytes(embedding) : null,
    embeddingModel: embedding ? spaceIdFor(embedding.length) : null,
    created_at,
  };
}

const setEnv = () => {
  process.env.EMBEDDING_API_URL = 'http://localhost:9999';
  process.env.EMBEDDING_MODEL = 'test-model';
};
const unsetEnv = () => {
  delete process.env.EMBEDDING_API_URL;
  delete process.env.EMBEDDING_MODEL;
};

async function insertMemory(row: MemRow): Promise<void> {
  await db.insert(memories).values({
    id: row.id,
    ownerId: 'owner',
    content: row.content,
    category: null,
    created_at: row.created_at,
    embedding: row.embedding,
    embeddingModel: row.embeddingModel,
    embeddedAt: row.embedding ? new Date() : null,
  });
}

async function clearMemories(): Promise<void> {
  await db.delete(memories).where(eq(memories.ownerId, 'owner'));
}

beforeEach(() => {
  setEnv();
});

afterEach(() => {
  unsetEnv();
  void clearMemories();
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
    await insertMemory(memoryRow('m1', 'hello', null, new Date()));
    const ok = await updateMemoryEmbedding('m1', 'hello', { embed: async () => V(0.25, 0.75) });
    expect(ok).toBe(true);
    const rows = await db.select().from(memories).where(eq(memories.id, 'm1'));
    expect(rows).toHaveLength(1);
    const vals = rows[0]!;
    expect(vals.embeddingModel).toBe(spaceIdFor(2));
    expect(vals.embedding).toBeInstanceOf(Buffer);
    const embedVec = Array.from(bytesToFloat32(vals.embedding as Buffer));
    expect(embedVec).toEqual([0.25, 0.75]);
    expect(vals.embeddedAt).toBeInstanceOf(Date);
  });

  test('returns false when embed yields nothing', async () => {
    const ok = await updateMemoryEmbedding('m1', 'hello', { embed: async () => null });
    expect(ok).toBe(false);
    const rows = await db.select().from(memories).where(eq(memories.id, 'm1'));
    expect(rows).toHaveLength(0);
  });
});

describe('findSemanticDuplicate', () => {
  test('disabled feature short-circuits to null without embedding', async () => {
    unsetEnv();
    const hit = await findSemanticDuplicate('owner', 'hello', { embed: async () => V(1) });
    expect(hit).toBeNull();
  });

  test('detects near-identical stored memory above threshold', async () => {
    await insertMemory(memoryRow('m1', 'the wifi password is hunter2', V(1, 0), new Date()));
    const hit = await findSemanticDuplicate('owner', 'the wifi password is hunter2!', {
      embed: async () => V(1, 0),
    });
    expect(hit?.id).toBe('m1');
    expect(hit?.similarity).toBeCloseTo(1);
  });

  test('ignores vectors written by a different embedding space', async () => {
    await db.insert(memories).values({
      id: 'm1',
      ownerId: 'owner',
      content: 'the wifi password is hunter2',
      category: null,
      created_at: new Date(),
      embedding: Buffer.from(V(1, 0).buffer),
      embeddingModel: 'embedding-space:v1:someotherendpoint',
      embeddedAt: null,
    });
    const hit = await findSemanticDuplicate('owner', 'the wifi password is hunter2!', {
      embed: async () => V(1, 0),
    });
    expect(hit).toBeNull();
  });

  test('ignores vectors whose dimension does not match the current space', async () => {
    await insertMemory(memoryRow('m1', 'stale vector', V(1, 0, 0), new Date()));
    const hit = await findSemanticDuplicate('owner', 'stale vector', {
      embed: async () => V(1, 0),
    });
    expect(hit).toBeNull();
  });

  test('unrelated content produces no duplicate', async () => {
    await insertMemory(memoryRow('m1', 'a', V(1, 0), new Date()));
    const hit = await findSemanticDuplicate('owner', 'b', {
      embed: async () => V(0, 1),
    });
    expect(hit).toBeNull();
  });

  test('embed failure degrades to null (insert allowed)', async () => {
    const hit = await findSemanticDuplicate('owner', 'hello', {
      embed: async () => {
        throw new Error('api down');
      },
    });
    expect(hit).toBeNull();
  });
});

describe('rankMemoriesForInjection', () => {
  test('empty query falls back to recency (null)', async () => {
    const ranked = await rankMemoriesForInjection('owner', '   ', { embed: async () => V(1) });
    expect(ranked).toBeNull();
  });

  test('vectors from a foreign embedding space are not ranked', async () => {
    await db.insert(memories).values({
      id: 'A',
      ownerId: 'owner',
      content: 'exact match',
      category: null,
      created_at: new Date(),
      embedding: Buffer.from(V(1, 0).buffer),
      embeddingModel: 'embedding-space:v1:elsewhere',
      embeddedAt: null,
    });
    const ranked = await rankMemoriesForInjection('owner', 'match me', {
      embed: async () => V(1, 0),
    }, 3);
    expect(ranked).toBeNull();
  });

  test('no embedded candidates falls back (null)', async () => {
    const ranked = await rankMemoriesForInjection('owner', 'hello', { embed: async () => V(1) });
    expect(ranked).toBeNull();
  });

  test('query embedding failure falls back (null)', async () => {
    await insertMemory(memoryRow('m1', 'a', V(1, 0), new Date()));
    const ranked = await rankMemoriesForInjection('owner', 'hello', {
      embed: async () => null,
    });
    expect(ranked).toBeNull();
  });

  test('ranks semantic head above recency tail, output chronological', async () => {
    const t1 = new Date('2026-01-01');
    const t2 = new Date('2026-02-01');
    const t3 = new Date('2026-03-01');
    await insertMemory(memoryRow('A', 'exact match', V(1, 0), t3));
    await insertMemory(memoryRow('B', 'orthogonal', V(0, 1), t1));
    await insertMemory(memoryRow('C', 'not yet embedded', null, t2));
    const ranked = await rankMemoriesForInjection('owner', 'match me', {
      embed: async () => V(1, 0),
    }, 3);
    expect(ranked?.map((r) => r.id)).toEqual(['B', 'C', 'A']);
  });

  test('maxMemories caps the selection keeping best matches', async () => {
    const t1 = new Date('2026-01-01');
    const t2 = new Date('2026-02-01');
    const t3 = new Date('2026-03-01');
    await insertMemory(memoryRow('A', 'exact match', V(1, 0), t3));
    await insertMemory(memoryRow('B', 'orthogonal', V(0, 1), t1));
    await insertMemory(memoryRow('C', 'not embedded', null, t2));
    const ranked = await rankMemoriesForInjection('owner', 'match me', {
      embed: async () => V(1, 0),
    }, 1);
    expect(ranked?.map((r) => r.id)).toEqual(['A']);
  });
});
