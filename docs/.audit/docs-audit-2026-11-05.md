# Documentation Audit — 2026-11-05

Scope: whole repository. Focus: none.

## Stale or Incorrect

1. **Location:** `docs/.agent/project-map.md` header. **Evidence:** recorded commit `e8073a6…` (2026-11-04) while HEAD is `f2fdb03…` (maintenance merge: teardown fix + env-var documentation + room-key unification). **Action taken:** updated recorded commit and date.

2. **Location:** `.opencode/memory/project.md` (memory note, not repo doc). **Evidence:** still claims migration `0024` has no `meta/0024_snapshot.json` and that `bun run db:generate` re-emits 0024's SQL. **Actual:** `drizzle/migrations/meta/0024_snapshot.json` exists and `bun run db:generate` reports "No schema changes, nothing to migrate". **Action:** memory-only; no repo doc change needed. Flagged for compaction.

3. **Location:** `docs/maintenance/audit-2026-11-04.md` and earlier audits reference deferred code items (AuthService.setRole race, process-global Scheduler/DigestService singletons, FlowHandler cleanup timer, WEBHOOK_QUERY_SECRET_COMPAT_ENABLED). **Evidence:** these are code/tech-debt items, not doc defects; they remain open in code. **Action:** none (docs already accurate).

## Missing Coverage

4. **Location:** `docs/api.md` admin route table. **Evidence:** `src/admin/routes.ts` exposes `GET /admin/api/session` and `GET /admin/api/*` views (`overview`, `tools`, `rooms`, `delivery`, `reminders`, `roomkeys`, `feedback`, `config`) plus action routes `reload-registry`, `retry-outbox`, `delete-knowledge`, `retention-report`. The doc's `GET /admin/api/*` line covers them generically. **Action:** none; generic contract is accurate and avoids drift.

5. **Location:** `docs/architecture.md` §9 (Durable Delivery). **Evidence:** `src/webhooks/adapters/` contains `github`, `seerr`, `jellyfin`, `generic`, `apprise`, `grafana` adapters; doc names only GitHub/Seerr/Jellyfin. **Action taken:** none required — adapters are internal; generic route covers the rest. Flagged for decision if operator-facing adapter docs are wanted.

6. **Location:** `docs/tools.md` execution model. **Evidence:** live tool progress (`src/agent/toolProgress.ts`, `BaseTool.describeAction`) already documented in 2026-11-04 audit. **Action:** verified present.

## Structural Problems

7. None new. Existing layout remains appropriate.

## Found While Documenting

- `src/admin/data.ts` `CONFIG_ALLOWLIST` still drifts from actual env reads: includes `EMBEDDING_ENDPOINT` (not read anywhere — actual keys are `EMBEDDING_API_URL`/`EMBEDDING_API_KEY`/`EMBEDDING_TIMEOUT_MS`), omits `JELLYFIN_*` capability keys, `SEERR_API_KEY`, per-provider `AI_<NAME>_*` capability flags, `AI_MAX_TOKENS_PARAM`, `AI_SUPPORTS_PARALLEL_TOOLS`. Recorded in prior audits; unchanged. Code change required, out of docs scope.
- `src/config/env.ts` `validateEnv` still does not validate `WEBHOOK_BODY_READ_TIMEOUT_MS`, `WEBHOOK_ENQUEUE_TIMEOUT_MS`, `WEBHOOK_READINESS_TIMEOUT_MS`, `WEBHOOK_MAX_*` (defaults in `src/webhooks/config.ts`). Recorded previously; unchanged.
- `src/tools/WebScrapeTool.ts` SSRF validation/redaction (`validateSsrfUrl`, `redactUrl`) still not described in `docs/tools.md`. Other URL-accepting tools validate too. Consider a one-line operator note.
- `docs/architecture.md` has two sections numbered "11" (Retention, then "11a. Background tasks"). Cosmetic; left as-is to avoid churn.

## Plan

Files updated:
- `docs/.agent/project-map.md` — recorded commit/date.
- `docs/.audit/docs-audit-2026-11-05.md` — this file.

Progress checklist:
- [x] Update project-map recorded commit
- [x] Create audit file
- [x] Run verification commands
- [x] Consistency pass

## Verification

Commands run:
- `bun run lint` — clean (`--max-warnings=0`).
- `bun run typecheck` — clean.
- `bun run db:check` — "Everything's fine".
- `bun run db:generate` — "No schema changes, nothing to migrate" (drift gate clean).
- `bun test --no-env-file test/` — 1557 pass, 0 fail, 126 files.

## Flagged for your decision

- Whether to reconcile `CONFIG_ALLOWLIST` in `src/admin/data.ts` with actual env reads (code change; out of scope for docs-only work).
- Whether to add env validation for `WEBHOOK_*` timeout/bound knobs in `src/config/env.ts`.
- Whether to document the webhook adapter set (`src/webhooks/adapters/`) and SSRF validation in `docs/tools.md`/`docs/api.md`.