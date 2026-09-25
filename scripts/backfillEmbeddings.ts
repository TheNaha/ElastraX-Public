import { asc, eq, isNull, ne, or } from 'drizzle-orm';
import { createDatabase, ensureDatabaseSchema, type DatabaseHandle } from '../src/db';
import { memories } from '../src/db/schema';
import { resolveDatabasePath } from '../src/config/database';
import { EmbeddingService, MAX_BATCH_SIZE } from '../src/utils/EmbeddingService';
import { float32ToBytes } from '../src/utils/semanticMemory';

export async function backfillEmbeddings(
  handle: DatabaseHandle,
  model: string,
  onProgress?: (done: number, pending: number) => void,
): Promise<number> {
  let done = 0;
  while (true) {
    const pending = handle.db
      .select({ id: memories.id, content: memories.content })
      .from(memories)
      .where(or(
        isNull(memories.embedding),
        isNull(memories.embeddingModel),
        ne(memories.embeddingModel, model),
      ))
      .orderBy(asc(memories.created_at), asc(memories.id))
      .limit(MAX_BATCH_SIZE)
      .all();

    if (pending.length === 0) return done;
    const vectors = await EmbeddingService.embed(pending.map(row => row.content));
    if (vectors.length !== pending.length) {
      throw new Error(`Embedding provider returned ${vectors.length} vectors for ${pending.length} memories`);
    }

    handle.db.transaction(transaction => {
      for (let index = 0; index < pending.length; index++) {
        const vector = vectors[index]!;
        if (vector.length === 0) throw new Error(`Embedding provider returned an empty vector for ${pending[index]!.id}`);
        transaction
          .update(memories)
          .set({ embedding: float32ToBytes(vector), embeddingModel: model, embeddedAt: new Date() })
          .where(eq(memories.id, pending[index]!.id))
          .run();
        done++;
      }
    });
    onProgress?.(done, pending.length);
  }
}

async function main(): Promise<void> {
  if (!EmbeddingService.isEnabled()) {
    throw new Error('Embeddings are not configured');
  }
  const model = process.env.EMBEDDING_MODEL?.trim();
  if (!model) throw new Error('EMBEDDING_MODEL is required');

  const handle = createDatabase({ path: resolveDatabasePath() });
  try {
    await ensureDatabaseSchema({ database: handle, leaseName: 'embedding-backfill' });
    let lastDone = 0;
    const done = await backfillEmbeddings(handle, model, completed => {
      if (completed !== lastDone) {
        lastDone = completed;
        console.log(`[db:embed] Completed ${completed} memories`);
      }
    });
    console.log(`[db:embed] Completed ${done} memories with ${model}`);
  } finally {
    handle.close();
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error('[db:embed] FAILED:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
