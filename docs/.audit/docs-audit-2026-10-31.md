# Documentation Audit — ElastraX

**Date:** 2026-10-31
**Scope:** whole repository (README, docs/, .env.example, inline doc comments)
**Baseline:** code on branch `main` at `86b3afe`.

## Stale or Incorrect

- `docs/room-identity-migration.md` (Storage model / Runtime contract) references `scheduled_deliveries` columns/rows, but migration `0024_drop_scheduled_deliveries.sql` removed that table and `src/db/schema.ts` has no `scheduled_deliveries` definition. Evidence: `grep -n scheduled_deliveries src/db/schema.ts` returns nothing. Proposed action: remove those references.
- `docs/README.md` and `README.md` describe flows as "schema-validated". There is no schema validation in `src/flows/registry.ts` or `src/core/FlowHandler.ts`; flows are registered processors over persisted sessions. Evidence: `grep -rni schema src/flows src/core/FlowHandler.ts` only matches the `flow_sessions` table import. Proposed action: reword to "persisted interactive flows".
- `docs/api.md` documents `/live` as `{"status":"ok"}`, but `src/webhooks/WebhookServer.ts` returns `{ status, version, releaseTag }` for `/health` and `/live`. Evidence: `sed -n '586,590p'`. Proposed action: include version/releaseTag in the example.
- `docs/tools.md` omits three registered tools: `digest` (`DigestTool`), `knowledge` (`KnowledgeTool`), and `speak` (`SpeakTool`). Evidence: `buildCoreTools()` in `src/tools/registry.ts`. Proposed action: add catalog entries.
- `docs/tools.md` does not note that `speak` is opt-in on `TTS_API_KEY` and `reload_plugins` is opt-in on `ENABLE_PLUGIN_RELOAD`. Evidence: `SpeakTool.isEnabled()` and `ReloadPluginsTool`/registry admission. Proposed action: annotate those entries.

## Missing Coverage

- `modal/` (experimental vLLM adapter) is documented in `modal/README.md` and `AGENTS.md`, but the top-level `README.md` only mentions it indirectly. Proposed action: add one sentence + link in README architecture/development section.
- The digest on-demand command `/digest [hours]` is mentioned in `.env.example` but not in `docs/tools.md`. Proposed action: mention in the digest tool entry.

## Structural Problems

- `docs/README.md` index describes Flows as "schema-validated flow definitions and validation"; same stale wording as above. Proposed action: align wording.

## Found While Documenting

- `src/config/runtime.ts` `getTurnBudgetConfig()` defaults `maxContextMessages` to `20` when `CONTEXT_MESSAGE_LIMIT` is unset, while `src/utils/ConfigService.ts` defaults the same env var to `10`. The two code paths disagree on the default. Not fixed; flagged for maintainer decision.
- `MEDIA_STORAGE_MAX_FILES` / `MEDIA_STORAGE_MAX_MB` `.env.example` examples (1000 files / 500 MB) differ from code defaults (10000 files / 2048 MB). The example values are overrides, not defaults; no code change needed, but the distinction should be clear (already commented).
- `docs/room-identity-migration.md` still references the removed `scheduled_deliveries` table; see stale item above.

## Plan

Files to update:

- `docs/.audit/docs-audit-2026-10-31.md` — this audit.
- `docs/room-identity-migration.md` — remove `scheduled_deliveries` references.
- `docs/README.md` — fix flows wording.
- `README.md` — fix flows wording; add modal note.
- `docs/api.md` — correct `/live` response shape.
- `docs/tools.md` — add digest, knowledge, speak entries and opt-in notes.

Progress checklist:

- [x] Audit written
- [x] room-identity-migration.md updated
- [x] docs/README.md updated
- [x] README.md updated
- [x] api.md updated
- [x] tools.md updated
- [x] Validation run (typecheck/lint/tests/db:check/db:generate all pass; 1563 tests)
