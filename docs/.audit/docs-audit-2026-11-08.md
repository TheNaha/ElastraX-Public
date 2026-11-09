# Documentation Audit — 2026-11-08

Scope: whole repository. Focus: none. Baseline commit: `cb82382` (branch `maintenance-pass-2026-11-08`). Baseline: `bun run check` green — 1565 tests pass, 0 fail, lint clean (`--max-warnings=0`), typecheck clean, `drizzle-kit check` clean; `bun run db:generate` reports "No schema changes, nothing to migrate"; `bun audit` clean. Markdown relative-link check across `docs/` and `README.md`: 0 broken links.

## Stale or Incorrect

1. **Location:** `README.md` Architecture section. **Evidence:** claimed `modal/` is "documented in `modal/README.md`", but no such file exists in the repository (the directory is untracked and contains only Python caches). **Action taken:** reworded to state `modal/` is an untracked, experimental adapter not part of the bot startup path or CI.

2. **Location:** `docs/.agent/project-map.md` header. **Evidence:** recorded commit was `f791823` (2026-11-07) while HEAD is `cb82382` (maintenance pass 2026-11-08). **Action taken:** updated recorded commit and date to `cb82382` / 2026-11-08.

3. **Location:** `docs/.agent/project-map.md` directory tree (`src/agent/`). **Evidence:** listed `src/agent/PromptBuilder.ts`, which does not exist; system-prompt loading lives in `src/core/prompts.ts` (`getDefaultSystemPrompt`) and substitution in `src/agent/index.ts`. **Action taken:** replaced the entry with `src/core/prompts.ts`.

## Missing Coverage

4. **Location:** `docs/tools.md` / `docs/api.md`. **Evidence:** webhook adapters `github`, `seerr`, `jellyfin`, `generic`, `apprise`, `grafana` are named in `docs/api.md` §Inbound payloads; `WebScrapeTool` performs SSRF validation/redaction (`validateSsrfUrl`, `redactUrl`). Already documented in the 2026-11-07 audit; no new gap found this pass.

5. **Location:** Configuration reference. **Evidence:** `.env.example` contains every env var read by `src/` and `scripts/` (static and family-pattern reads verified by comparing the extracted read set against the example); only test/runtime-internal keys (`BUN_TEST`, `VITEST`, `HOME`, `ELASTRAX_TEST_*`, `DB_BACKUP_PATH`, `DB_RESTORE_PATH`) are absent, and those are documented in `docs/scripts.md` or are Bun/Node internals. No `.env.example` change required.

## Structural Problems

6. **Location:** `docs/architecture.md` §§11/11a. **Evidence:** two adjacent sections share the number "11" ("11. Retention", "11a. Background tasks"). Cosmetic; no external references. Carried over from prior audits; left as-is.

7. **Location:** `docs/` topic split. **Evidence:** README/docs index cross-references resolve (0 broken links). Layout remains appropriate; no reorganization needed.

## Found While Documenting

- `src/admin/data.ts` `CONFIG_ALLOWLIST` still drifts from actual env reads: includes `EMBEDDING_ENDPOINT` (never read) and omits `EMBEDDING_API_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_TIMEOUT_MS`, `EMBEDDING_CANDIDATES`, `EMBEDDING_DEDUPE_THRESHOLD`, `JELLYFIN_API_URL`, `JELLYFIN_API_KEY`, `JELLYFIN_EXTERNAL_URL`, `SEERR_API_KEY`, `SEERR_API_URL` (only `SEERR_URL` listed), `JINA_API_KEY`, `SEARXNG_URL`, and `ELASTRAX_DB_SYNCHRONOUS`. Carried over from prior audits; requires a code change, out of docs scope. Not fixed.
- `src/config/env.ts` `validateEnv` still does not validate `WEBHOOK_BODY_READ_TIMEOUT_MS`, `WEBHOOK_ENQUEUE_TIMEOUT_MS`, `WEBHOOK_READINESS_TIMEOUT_MS`, or the `WEBHOOK_MAX_*` bounds (defaults live in `src/webhooks/config.ts`). Carried over from prior audits; requires a code change, out of docs scope. Not fixed.
- `src/db/index.ts` exports `afterMigrationCallbacks`, but no code ever pushes to it (inert hook) — TD-014 from the 2026-11-07 maintenance audit. Public-surface hygiene item, not a doc defect.
- `docs/architecture.md` duplicate "11"/"11a" section numbers (cosmetic).
- Maintenance pass 2026-11-08 flagged 6 exported-but-unused symbols (`databaseLeases`, `roomKeyConflicts`, `dbSchemaMeta`, `RoleMutation`, `canManageRoleScope`, `ReloadPluginsTool`) and 7 integration gaps (IG-01..IG-07). These are code-surface/contract items, out of docs scope; recorded in `docs/maintenance/audit-2026-11-08.md`. No doc change.
- `modal/` is untracked in this checkout (only `__pycache__`/`.ruff_cache` present); README previously pointed at a non-existent `modal/README.md`. Corrected.

## Plan

Files to update/create:
- `docs/.audit/docs-audit-2026-11-08.md` (create) — this audit, plan, checklist, and verification record.
- `README.md` (update) — `modal/` reference corrected.
- `docs/.agent/project-map.md` (update) — recorded commit `f791823` → `cb82382`, date 2026-11-07 → 2026-11-08; `PromptBuilder.ts` → `src/core/prompts.ts`.

Progress checklist:

- [x] Baseline checks recorded (green).
- [x] Audit file created.
- [x] `README.md` modal reference corrected.
- [x] `docs/.agent/project-map.md` recorded commit and PromptBuilder entry updated.
- [x] Verification commands run.
- [x] Consistency pass (terminology, links).

## Verification

Commands run:
- `bun run check` — pass (1565 tests, 0 fail; lint clean; typecheck clean; `drizzle-kit check` clean).
- `bun run db:generate` — "No schema changes, nothing to migrate" (drift gate clean).
- `bun audit --audit-level=high` — clean.
- Markdown relative-link check across `docs/` and `README.md` — 0 broken links.
- Env-var coverage check: extracted the set of env keys read by `src/` and `scripts/` (static `process.env.X`/`env.X` plus family patterns) and compared against `.env.example`; only test/runtime-internal keys absent (documented or Bun/Node internals).

## Flagged for your decision

- Whether to reconcile `CONFIG_ALLOWLIST` in `src/admin/data.ts` with actual env reads (code change; out of docs scope).
- Whether to add env validation for `WEBHOOK_*` timeout/bound knobs in `src/config/env.ts`.
- Whether to renumber `docs/architecture.md` sections 11/11a.
- Whether to remove/un-export the 6 dead symbols and address the 7 integration gaps (IG-01..IG-07) flagged in `docs/maintenance/audit-2026-11-08.md`.