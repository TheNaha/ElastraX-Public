# Documentation Audit — 2026-11-09

Scope: whole repository. Focus: none. Branch: `maintenance-pass-2026-11-09` (from `main`).
Baseline commit: `5bceb63 docs(maintenance): record 2026-11-09 maintenance pass audit`.
Baseline checks: `bun run check` green (1565 tests, 0 fail; lint `--max-warnings=0` clean; typecheck clean; `drizzle-kit check` clean); `bun run db:generate` drift gate clean; `bun audit --audit-level=high` clean.

This pass re-verified every doc in `docs/` plus `README.md` against the code, and re-ran the env-var coverage check (every `process.env.X`/`env.X` read in `src/` and `scripts/` is represented in `.env.example`; only test/runtime-internal keys are absent).

## Stale or Incorrect

1. **`README.md`** — Architecture section previously pointed at a non-existent `modal/README.md`.
   - Evidence: `modal/` is untracked in this checkout (only caches present) and is not part of the bot startup path or CI.
   - Status: corrected in working tree (uncommitted): "…(not tracked in this repo, not part of the bot startup path or CI)."

2. **`docs/.agent/project-map.md`** — Recorded commit `cb82382` (2026-11-08) while HEAD is `5bceb63` (2026-11-09). The `src/agent/PromptBuilder.ts` entry was already replaced with `src/core/prompts.ts` in the working tree (uncommitted).
   - Evidence: HEAD moved one commit since the last project-map recording; AGENTS.md says to update the map when HEAD has moved.
   - Action: update recorded commit to `5bceb63` / date to `2026-11-09`.

3. **`docs/architecture.md`** — Two adjacent sections share the number "11" ("11. Retention", "11a. Background tasks").
   - Evidence: cosmetic only, no external references, carried over from prior audits.
   - Action: renumber Background tasks to "12" and shift subsequent sections (Digests → 13, Admin Dashboard → 14, Logging and Error Handling → 15, Reaction Feedback → 16) for a clean sequence.

## Missing Coverage

4. No doc gap found. Coverage check:
   - Architecture/layout: `docs/architecture.md`, `docs/.agent/project-map.md`, README §Architecture — accurate.
   - Configuration: `.env.example` complete and annotated (verified by read-set comparison); README §Configuration and setup.md §2 reference it.
   - Entry points/data flow: `src/index.ts` → `AppRuntime` → providers/scheduler/webhookServer → agent loop — documented in architecture.md §1, §3, §11a and README.
   - Background jobs/timers: architecture.md §11a lists every interval (rate-limiter prune 10m, outbox worker 1s, outbox/inbox/flow/media/retention hourly, startup coverage scan, scheduler/digest loops).
   - Scripts/CLI: `docs/scripts.md` enumerates every `package.json` script including `db:preflight`, `db:room-keys`, `db:embed`, `db:retention`, `fixtures:dump`.
   - API/webhooks: `docs/api.md` matches `src/webhooks/WebhookServer.ts` routes (`/health`, `/live`, `/ready`, `/metrics`, `/admin/*`, four POST webhook paths) and the `registerEnqueuer` 202 contract.
   - Tools: `docs/tools.md` matches `src/tools/registry.ts` (built-in + opt-in + plugin tools, mutability, loading modes).
   - Error handling/logging: architecture.md §14 (Pino, ProviderError/AIProtocolError/WebhookRequestError codes, startup validation).
   - Local testing: setup.md §Testing (hermetic harness, `--no-env-file`, temp DB/media, `*Deps` seams).
   - Deployment/containerization: `docs/deployment.md`, `docs/canary-runbook.md`, README §Docker — match Dockerfile, docker-compose.yml, and litestream.yml.example.

## Structural Problems

5. None beyond the duplicate section numbering in item 3. README/docs index cross-references resolve (0 broken links, re-verified this pass). Layout remains appropriate; no reorganization needed.

## Found While Documenting

- `src/admin/data.ts` `CONFIG_ALLOWLIST` drifts from actual env reads (includes `EMBEDDING_ENDPOINT`, never read; omits `EMBEDDING_API_URL`, `JELLYFIN_API_URL`, `SEERR_API_URL`, etc.). Code change, out of docs scope; recorded in prior audits. Not fixed.
- `src/config/env.ts` does not validate `WEBHOOK_*` timeout/bound knobs (defaults live in `src/webhooks/config.ts`). Code change, out of docs scope. Not fixed.
- `src/db/index.ts` exports `afterMigrationCallbacks` but nothing pushes to it (inert hook). Public-surface hygiene, not a doc defect.
- `modal/` untracked; README previously pointed at `modal/README.md`. Corrected (item 1).

## Plan — files to touch

| File | Change | Reason |
|------|--------|--------|
| `README.md` | Confirm modal-reference correction already in working tree | Stale reference to non-existent `modal/README.md` |
| `docs/.agent/project-map.md` | Recorded commit `cb82382` → `5bceb63`; date `2026-11-08` → `2026-11-09` | HEAD moved; keep map accurate per AGENTS.md |
| `docs/architecture.md` | Renumber §11a Background tasks → §12, shift following sections | Duplicate section number "11" |
| `docs/.audit/docs-audit-2026-11-09.md` | Create this audit | Record findings and plan |

Progress checklist:
- [ ] Baseline checks recorded (green)
- [ ] Audit file created
- [ ] `README.md` modal reference confirmed corrected (working tree)
- [ ] `docs/.agent/project-map.md` commit and date updated
- [ ] `docs/architecture.md` section numbering fixed
- [ ] Verification commands run
- [ ] Consistency pass (terminology, links)

## Verification

Commands to run:
- `bun run check` — lint, typecheck, tests, `drizzle-kit check`
- `bun run db:generate` — drift gate ("No schema changes, nothing to migrate")
- `bun audit --audit-level=high` — security audit clean
- Markdown relative-link check across `docs/` and `README.md` — 0 broken links

## Flagged for your decision

- Whether to commit the already-applied `README.md` and `docs/.agent/project-map.md` working-tree changes (they match this audit's items 1 and 2).
- Nothing else requires a code change; all remaining flagged items are out of docs scope.
