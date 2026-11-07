# Documentation Audit — 2026-11-07

Scope: whole repository. Focus: none. Baseline commit: `f791823` (branch `maintenance-pass-2026-11-07`). Baseline: `bun run check` green — 1565 tests pass, 0 fail, lint clean (`--max-warnings=0`), typecheck clean, `drizzle-kit check` clean; `bun run db:generate` reports "No schema changes, nothing to migrate"; `bun audit` clean.

## Stale or Incorrect

1. **Location:** `docs/.agent/project-map.md` header. **Evidence:** recorded commit was `cb01aae…` (2026-11-06) while HEAD is `f791823…` (maintenance pass 2026-11-07, 30 files changed including `src/utils/toolAccess.ts`, `src/utils/date.ts`, `src/db/rooms.ts`, provider fixes). **Action taken:** updated recorded commit and date to `f791823` / 2026-11-07.

2. **Location:** `docs/api.md` admin route table (lines 21–22). **Evidence:** `src/admin/routes.ts` `handleRead` serves `api/overview`, `api/tools`, `api/rooms`, `api/delivery`, `api/reminders`, `api/roomkeys`, `api/feedback`, `api/config`; `handleAction` serves `api/action/reload-registry`, `api/action/retry-outbox`, `api/action/delete-knowledge`, `api/action/retention-report`. The doc listed only a subset (overview, rooms, deliveries, config, feedback; registry reload, retention report, outbox retry). **Action taken:** expanded the view/action summaries to match the code.

3. **Location:** `docs/architecture.md` §§11/11a. **Evidence:** two adjacent sections are both numbered "11" ("11. Retention" then "11a. Background tasks"), noted as cosmetic in the 2026-11-05 audit. No external references to the numbers exist. **Action:** flagged only; left as-is to avoid churn (reorganizing is out of scope unless the layout is the problem).

## Missing Coverage

4. **Location:** `docs/api.md` (admin contract). **Evidence:** the generic `GET /admin/api/*` / `POST /admin/api/action/*` lines are accurate as a contract, but the per-endpoint inventory above was incomplete. **Action taken:** see item 2.

5. **Location:** `docs/tools.md` / `docs/api.md`. **Evidence:** `src/webhooks/adapters/` ships `github`, `seerr`, `jellyfin`, `generic`, `apprise`, `grafana` adapters; only GitHub/Seerr/Jellyfin were named in operator docs. `src/tools/WebScrapeTool.ts` performs SSRF validation/redaction (`validateSsrfUrl`, `redactUrl`). **Action taken:** added a concise inbound-adapter summary to `docs/api.md` and an SSRF note to the Web Scrape row in `docs/tools.md`. Adapter-specific request shapes remain documented only where the code defines them, to avoid drift.

6. **Location:** `docs/architecture.md` §14 (Logging and Error Handling). **Evidence:** `src/utils/toolAccess.ts` (new in this pass) centralises `hasPermission` / `bindingPlatformMismatch`, but it is an internal helper, not a public contract. **Action:** none.

## Structural Problems

7. **Location:** `docs/` topic split. **Evidence:** README/docs index cross-references resolve (0 broken links checked this pass). The existing layout remains appropriate; no reorganization needed.

## Found While Documenting

- `src/admin/data.ts` `CONFIG_ALLOWLIST` still drifts from actual env reads: includes `EMBEDDING_ENDPOINT` (never read) and omits `EMBEDDING_API_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_TIMEOUT_MS`, `EMBEDDING_CANDIDATES`, `EMBEDDING_DEDUPE_THRESHOLD`, `JELLYFIN_API_URL`, `JELLYFIN_API_KEY`, `JELLYFIN_EXTERNAL_URL`, `SEERR_API_KEY`, `SEERR_API_URL` (only `SEERR_URL` listed), `JINA_API_KEY`, `SEARXNG_URL`, and `ELASTRAX_DB_SYNCHRONOUS`. Carried over from prior audits; requires a code change, out of docs scope. Not fixed.
- `src/config/env.ts` `validateEnv` still does not validate `WEBHOOK_BODY_READ_TIMEOUT_MS`, `WEBHOOK_ENQUEUE_TIMEOUT_MS`, `WEBHOOK_READINESS_TIMEOUT_MS`, or the `WEBHOOK_MAX_*` bounds (defaults live in `src/webhooks/config.ts`). Carried over from prior audits; requires a code change, out of docs scope. Not fixed.
- `src/db/index.ts` exports `afterMigrationCallbacks`, but no code ever pushes to it (inert hook) — TD-014 from the 2026-11-07 maintenance audit. Public-surface hygiene item, not a doc defect.
- `docs/architecture.md` duplicate "11"/"11a" section numbers (cosmetic).

## Plan

Files to update/create:

- `docs/.audit/docs-audit-2026-11-07.md` (create) — this audit, plan, checklist, and verification record.
- `docs/.agent/project-map.md` (update) — recorded commit `cb01aae…` → `f791823…` and date 2026-11-06 → 2026-11-07.
- `docs/api.md` (update) — admin dashboard view/action summaries to match `src/admin/routes.ts`; added inbound-adapter note.
- `docs/tools.md` (update) — noted SSRF validation/redaction on Web Scrape.

Progress checklist:

- [x] Baseline checks recorded (green).
- [x] Audit file created.
- [x] Project-map recorded commit updated.
- [x] `docs/api.md` admin route summaries corrected.
- [x] Verification commands run.
- [x] Consistency pass (terminology, links).

## Verification

Commands run:

- `bun run check` — pass (1565 tests, 0 fail; lint clean; typecheck clean; `drizzle-kit check` clean).
- `bun run db:generate` — "No schema changes, nothing to migrate" (drift gate clean).
- Markdown relative-link check across `docs/` and `README.md` — 0 broken links.
- Admin route summaries verified against `src/admin/routes.ts` `handleRead`/`handleAction`.

## Flagged for your decision

- Whether to document the webhook adapter set (`github`, `seerr`, `jellyfin`, `generic`, `apprise`, `grafana`) and the SSRF validation in `WebScrapeTool` as operator-facing notes in `docs/api.md`/`docs/tools.md`.
- Whether to reconcile `CONFIG_ALLOWLIST` in `src/admin/data.ts` with actual env reads (code change; out of docs scope).
- Whether to add env validation for `WEBHOOK_*` timeout/bound knobs in `src/config/env.ts`.
- Whether to renumber `docs/architecture.md` sections 11/11a.
