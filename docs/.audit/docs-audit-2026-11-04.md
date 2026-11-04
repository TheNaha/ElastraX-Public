# Documentation Audit — 2026-11-04

Scope: whole repository. Focus: none.

## Stale or Incorrect

1. **Location:** `docs/.agent/project-map.md` header. **Evidence:** recorded commit `78258c5…` (2026-11-03) while HEAD is `e8073a6…` (live tool progress + runtime teardown fix). **Action taken:** updated recorded commit and date.

2. **Location:** `.env.example` Database section. **Evidence:** `src/db/index.ts` reads `ELASTRAX_DB_BUSY_TIMEOUT_MS` (default 5000, range 0–120000) via `integerSetting`, but the variable is absent from `.env.example`. **Action taken:** added the commented entry.

## Missing Coverage

3. **Location:** `docs/architecture.md` §3 (Agent Loop) and `docs/tools.md` (Execution model). **Evidence:** `src/agent/toolProgress.ts` (`ToolProgressTracker`, `formatToolAction`) and `BaseTool.describeAction` now drive a live, edited status message per tool step with `[i/N]` counters and ✅/❌ icons; the final answer is delivered separately. No doc mentioned this user-facing behaviour. **Action taken:** added one-line notes in both files.

4. **Location:** `docs/architecture.md` §9 (Durable Delivery). **Evidence:** `src/messaging/InboxService.ts` and `src/messaging/OutboxService.ts` dead-letter a row after `MAX_ATTEMPTS = 5` and use attempt-aware exponential backoff; stranded in-flight rows are re-queued or dead-lettered by `recoverStranded`. The doc only said "retried on failure". **Action taken:** extended the section.

5. **Location:** `docs/tools.md` execution model. **Evidence:** opt-in gating and slash-command behaviour documented; live progress now also part of the model. **Action taken:** added note.

## Structural Problems

6. None new. Existing layout (docs split by topic) remains appropriate.

## Found While Documenting

- `src/admin/data.ts` `CONFIG_ALLOWLIST` still drifts from actual env reads (includes `EMBEDDING_ENDPOINT`, omits read keys such as `JELLYFIN_*`, `SEERR_API_KEY`, `EMBEDDING_API_URL`/`EMBEDDING_API_KEY`/`EMBEDDING_TIMEOUT_MS`, `AI_MAX_TOKENS_PARAM`, per-provider `AI_<NAME>_*` capability flags). Recorded in previous audits; unchanged.
- `src/config/env.ts` `validateEnv` still does not validate `WEBHOOK_BODY_READ_TIMEOUT_MS`, `WEBHOOK_ENQUEUE_TIMEOUT_MS`, `WEBHOOK_READINESS_TIMEOUT_MS`, `WEBHOOK_MAX_*` (defaults in `src/webhooks/config.ts`). Recorded previously; unchanged.
- Deferred code items from the 2026-11-03 maintenance audit remain open: `AuthService.setRole` check-then-insert race; process-global `Scheduler`/`DigestService` singletons clobbering across runtimes in tests; `FlowHandler` session-cleanup timer not cleared on `stop()`; `WEBHOOK_QUERY_SECRET_COMPAT_ENABLED` opt-in risk. Out of scope for docs.
- `src/tools/WebScrapeTool.ts` SSRF validation/redaction (`validateSsrfUrl`, `redactUrl`) is not described in `docs/tools.md`; other URL-accepting tools already validate. Consider a one-line operator note if needed.

## Plan

Files updated:
- `docs/.agent/project-map.md` — recorded commit/date.
- `.env.example` — add `ELASTRAX_DB_BUSY_TIMEOUT_MS`.
- `docs/architecture.md` — live tool progress note + dead-letter note.
- `docs/tools.md` — live tool progress note.
- `docs/.audit/docs-audit-2026-11-04.md` — this file.

Progress checklist:
- [x] Update project-map recorded commit
- [x] Add ELASTRAX_DB_BUSY_TIMEOUT_MS to .env.example
- [x] Add live tool progress note to architecture.md
- [x] Add dead-letter note to architecture.md durable delivery
- [x] Add live tool progress note to tools.md
- [x] Run verification commands
- [x] Consistency pass

## Verification

Commands run:
- `bun run lint` — clean (`--max-warnings=0`).
- `bun run typecheck` — clean.
- `bun run db:check` — "Everything's fine".
- `bun test --no-env-file test/` — 1557 pass, 0 fail, 126 files.
- `bun run db:generate` — "No schema changes, nothing to migrate" (drift gate clean).

## Flagged for your decision

- Whether to reconcile `CONFIG_ALLOWLIST` in `src/admin/data.ts` with actual env reads (code change; out of scope for docs-only work).
- Whether to add env validation for `WEBHOOK_*` timeout/bound knobs in `src/config/env.ts`.