# Documentation Audit — 2026-11-11

Scope: whole repository. Focus: none. Branch: `main`.
Baseline commit: `c21a38d maint: merge 2026-11-10 maintenance pass`.
Baseline checks: `bun run lint` clean, `bun run typecheck` clean, `bun test --no-env-file test/` 1592 pass / 0 fail (128 files), `bun run db:check` clean, `bun audit --audit-level=high` clean (278 packages).

This pass re-verified every doc in `docs/` plus `README.md` against the code, including a full env-var coverage check (every `process.env.X`/`env.X` read in `src/` and `scripts/` is represented in `.env.example`; only test/runtime-internal overrides such as `DB_BACKUP_PATH`/`DB_RESTORE_PATH` and `ELASTRAX_TEST_*` are absent, which is correct).

## Stale or Incorrect

1. **`docs/architecture.md`** — Heading-level inconsistency: numbered sections 1–7 use `###` (children of `## Core Concepts`) while sections 8–16 use `##` (siblings of `## Core Concepts`), breaking the outline.
   - Evidence: `grep -nE '^#+' docs/architecture.md` shows `### 1.`…`### 7.` then `## 8.`…`## 16.`
   - Action: renumber sections 8–16 from `##` to `###` so all 16 numbered concepts are consistent `###` children of `## Core Concepts`.

2. **`docs/architecture.md` §6** — Claims AI providers "are instantiated lazily". `ModelRouter.loadProviders()` is invoked in the constructor and constructs `new AIClient(...)` for every configured provider eagerly; nothing is lazy.
   - Evidence: `src/utils/ModelRouter.ts` lines 98–154 (`constructor` → `loadProviders()` → `new AIClient(...)` per target).
   - Action: reword to state clients are constructed when the router is built, and clarify that service-health checks are run by `src/utils/HealthMonitor.ts` while `src/utils/HealthMetrics.ts` records request/token metrics.

## Missing Coverage

3. None found. Coverage check:
   - Architecture/layout: `docs/architecture.md`, `docs/.agent/project-map.md`, README §Architecture — accurate.
   - Configuration: `.env.example` complete and annotated (verified by read-set comparison); README §Configuration and setup.md §2 reference it.
   - Entry points/data flow: `src/index.ts` → `AppRuntime` → providers/scheduler/webhookServer → agent loop — documented in architecture.md §1, §3, §12 and README.
   - Background jobs/timers: architecture.md §12 lists every interval (rate-limiter prune 10m, outbox worker 1s, outbox/inbox/flow/media/retention hourly, startup coverage scan 5s, scheduler/digest loops) — verified against `src/runtime/AppRuntime.ts`.
   - Scripts/CLI: `docs/scripts.md` enumerates every `package.json` script including `db:studio`, `db:preflight`, `db:room-keys`, `db:embed`, `db:retention`, `fixtures:dump`.
   - API/webhooks: `docs/api.md` matches `src/webhooks/WebhookServer.ts` routes (`/health`, `/live`, `/ready`, `/metrics`, `/admin/*`, four POST webhook paths) and the `registerEnqueuer` 202 contract. Admin static assets `/admin/app.js`, `/admin/style.css` and the `/admin` → `/admin/login` 302 redirect are confirmed in `src/admin/routes.ts`.
   - Tools: `docs/tools.md` matches `src/tools/registry.ts` (built-in + opt-in + plugin tools, mutability, loading modes).
   - Error handling/logging: architecture.md §15 (Pino, ProviderError/AIProtocolError/WebhookRequestError codes, startup validation) — verified against `src/utils/logger.ts`, `src/config/env.ts`, `src/providers/errors.ts`, `src/ai/errors.ts`, `src/webhooks/types.ts`.
   - Local testing: setup.md §Testing (hermetic harness, `--no-env-file`, temp DB/media, `*Deps` seams).
   - Deployment/containerization: `docs/deployment.md`, `docs/canary-runbook.md`, README §Docker — match Dockerfile, docker-compose.yml, and litestream.yml.example.
   - Dead-letter after 5 attempts: architecture.md §9 — confirmed `MAX_ATTEMPTS = 5` in both `src/messaging/OutboxService.ts` and `src/messaging/InboxService.ts`.
   - Migration `0022_room_keys`: architecture.md §5 — confirmed present in `drizzle/migrations/` and `drizzle/migrations/meta/_journal.json`.

## Structural Problems

4. None beyond item 1 (heading levels). README/docs index cross-references resolve (0 broken links). Layout remains appropriate; no reorganization needed.

## Found While Documenting

- `src/index.ts` lines 102–106 contain a stale comment ("…was never armed in production") that contradicts line 109, which wires `runStartupCoverageScan`. This is a code doc comment, not a user-facing doc; flagged but left for the code owner since it does not affect any documentation file.
- `modal/` exists on disk but is untracked in git (0 files) and is not part of the bot startup path or CI; README's statement is accurate.

## Plan — files to touch

| File | Change | Reason |
|------|--------|--------|
| `docs/.audit/docs-audit-2026-11-11.md` | Create this audit | Record findings and plan |
| `docs/architecture.md` | Sections 8–16 `##` → `###` | Fix heading-level inconsistency under `## Core Concepts` |
| `docs/architecture.md` §6 | Reword "instantiated lazily" + health tracking attribution | Match `ModelRouter` eager construction; separate HealthMonitor vs HealthMetrics roles |

Progress checklist:
- [x] Baseline checks recorded (green)
- [x] Audit file created
- [x] `docs/architecture.md` heading levels fixed (sections 8–16 `##` → `###`)
- [x] `docs/architecture.md` §6 reworded (eager construction; HealthMonitor vs HealthMetrics)
- [x] Verification commands run (lint clean, typecheck clean)
- [x] Consistency pass (terminology, links)

## Verification

Commands to run:
- `bun run lint` — eslint `--max-warnings=0`
- `bun run typecheck` — `tsc --noEmit`
- Markdown heading/structure review of `docs/architecture.md`

## Flagged for your decision

- None. Both changes are doc-only and non-controversial.