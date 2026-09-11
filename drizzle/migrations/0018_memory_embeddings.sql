-- 0018: Semantic memory (RAG 2.0) + generic key/value store.
--
-- memories gains embedding columns so long-term memories can be ranked by
-- semantic similarity to the current conversation turn instead of pure recency:
--   embedding       — Float32Array bytes (BLOB) from the configured embeddings API
--   embedding_model — model name that produced the vector (invalidation marker)
--   embedded_at     — when the vector was computed
--
-- app_kv is a tiny generic key/value table used for exactly-once scheduled-job
-- markers (e.g. daily digest / weekly media digest last-run dates).
ALTER TABLE memories ADD embedding BLOB;
--> statement-breakpoint
ALTER TABLE memories ADD embedding_model TEXT;
--> statement-breakpoint
ALTER TABLE memories ADD embedded_at INTEGER;
--> statement-breakpoint

CREATE TABLE app_kv (
	id TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
