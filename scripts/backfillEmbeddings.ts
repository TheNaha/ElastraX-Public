/**
 * @file scripts/backfillEmbeddings.ts
 * @usage bun run db:embed
 * @description One-off/periodic backfill: computes embeddings for every memory
 *              row that is missing one (or was embedded with a different model)
 *              so semantic recall covers the full history.
 *
 * Requires EMBEDDING_API_URL + EMBEDDING_MODEL in .env (or environment).
 * Batches requests, logs progress, and is safe to re-run — already-embedded
 * rows with the current model are skipped.
 */

import { db } from '../src/db';
import { memories } from '../src/db/schema';
import { asc, eq, isNull, ne, or } from 'drizzle-orm';
import { EmbeddingService } from '../src/utils/EmbeddingService';
import { float32ToBytes } from '../src/utils/semanticMemory';

async function main(): Promise<void> {
  if (!EmbeddingService.isEnabled()) {
    console.error('Embeddings not configured. Set EMBEDDING_API_URL and EMBEDDING_MODEL first.');
    process.exit(1);
  }
  const model = process.env.EMBEDDING_MODEL!.trim();

  // Missing vector OR vector produced by an older/different model
  // (never-embedded rows have embedding/embedding_model = NULL).
  const pending = db.select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(or(
      isNull(memories.embedding),
      isNull(memories.embeddingModel),
      ne(memories.embeddingModel, model),
    ))
    .orderBy(asc(memories.created_at))
    .all();

  if (pending.length === 0) {
    console.log(`All memories already embedded with model ${model}. Nothing to do.`);
    return;
  }

  console.log(`Backfilling ${pending.length} memories with model ${model}...`);
  let done = 0;
  for (let i = 0; i < pending.length; i += EmbeddingService.MAX_BATCH_SIZE) {
    const batch = pending.slice(i, i + EmbeddingService.MAX_BATCH_SIZE);
    const vectors = await EmbeddingService.embed(batch.map(r => r.content));
    for (let j = 0; j < batch.length; j++) {
      const vec = vectors[j]!;
      if (vec.length === 0) continue;
      db.update(memories)
        .set({ embedding: float32ToBytes(vec), embeddingModel: model, embeddedAt: new Date() })
        .where(eq(memories.id, batch[j]!.id))
        .run();
      done++;
    }
    console.log(`  ${Math.min(i + batch.length, pending.length)}/${pending.length}`);
  }
  console.log(`Done. Embedded ${done}/${pending.length} memories.`);
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
