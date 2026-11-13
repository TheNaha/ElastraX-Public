# Documentation audit — 2026-11-13

Scope: whole repo. Focus: none. Branch: `maint/2026-11-12-full-pass`.

## Baseline (verified before changes)

- `bun run lint` (eslint `--max-warnings=0`): clean
- `bun run typecheck` (`tsc --noEmit`): clean
- `bun run db:check` (`drizzle-kit check`): clean ("Everything's fine")
- Sample tests (`PingTool`, `versioning`, `constants`, `roomKey`): 29 pass / 0 fail

## Method

Compared every doc under `docs/` plus `README.md` and `AGENTS.md` against the code
(`src/`, `scripts/`, `.github/workflows/`, `Dockerfile`, `docker-compose.yml`,
`package.json`, `.env.example`). Claims were checked by reading the implementing
module and, where safe, by running the documented command. Spot-checked areas:
env-var defaults/ranges (`src/config/env.ts`, `src/config/runtime.ts`,
`src/webhooks/config.ts`, `src/db/index.ts`), webhook routes (`src/webhooks/WebhookServer.ts`),
AppRuntime lifecycle and timers (`src/runtime/AppRuntime.ts`), Scheduler/Digest/HealthMonitor
poll intervals, Inbox/Outbox leases and dead-lettering, version constants
(`src/config/version.ts`), and CI gates (`.github/workflows/ci.yml`,
`docker-publish.yml`).

## 1. Stale or incorrect

| # | Location | Issue | Evidence | Action |
|---|----------|-------|----------|--------|
| 1 | `AGENTS.md` | References `docs/.agent/project-map.md` ("A map of this project lives at ..."). File does not exist. | `glob docs/.agent/project-map.md` → none | Create the project map or remove the reference (chose: create `docs/.agent/project-map.md`) |
| 2 | `AGENTS.md` | References root `AUDIT*.md` files ("Audit docs in repo root (AUDIT*.md): AUDIT-2026-10-PHASE1.md ..."). No `AUDIT*.md` exists at root; audits live under `docs/maintenance/`. | `ls AUDIT*.md` → no match; audits are in `docs/maintenance/audit-*.md` | Repoint to `docs/maintenance/` |
| 3 | `.dockerignore` line 29 | References `AUDIT.md`, which does not exist at the repo root. | `ls AUDIT.md` → no match | Drop the `AUDIT.md` line |
| 4 | `docs/configuration.md` §2 (`AI_MODEL_NAME`) | Says `AI_MODEL_NAME` "falls back to `meta-llama/Meta-Llama-3-8B-Instruct` ... if unset at read time in `config/llm.ts`", but `validateEnv` (`src/config/env.ts:97-98`) REQUIRES `AI_MODEL_NAME` in single-provider mode and throws before any fallback is reached. The `resolveLLMProviders` default is defense-in-depth, never reached when the var is unset. | `src/config/env.ts:96-98`; `src/config/llm.ts:97` | Reword the row: required in single-provider mode; keep the read-time default noted as unreachable defense-in-depth |
| 5 | `.env.example` line 376 | Comment `# ELASTRAX_DB_SYNCHRONOUS=NORMAL` shows NORMAL as the value, but the code default (`src/db/index.ts:82-87`, `synchronousSetting`) is `FULL`. Contradicts `docs/configuration.md` §21 (default `FULL`). | `src/db/index.ts:85` `if (!value) return 'FULL'` | Change the commented example to `FULL` to match the real default |

## 2. Missing coverage / gaps

| # | Location | Issue | Action |
|---|----------|-------|--------|
| 6 | `docs/.agent/project-map.md` | Exists and is accurate (recorded at commit b4ad7af, 2026-11-10). HEAD is now `maint/2026-11-12-full-pass`; the map's directory tree matches the current `src/` layout, so no change is required. AGENTS.md's reference is valid. | None (verified) |

## 3. Structural problems

None found. The docs are well organized, internally consistent, and accurate for the large majority of claims. No abandoned workflows, legacy endpoints, or obsolete setup steps were detected; CI (`.github/workflows/ci.yml`) matches `docs/deployment.md` and `docs/ci-diagnostics.md`.

## 4. Found while documenting (code observations, not fixed)

- `docs/maintenance/audit-2026-11-12.md` already flags 18 exported-but-unused symbols and integration gaps IG-01..IG-09 as deferred, user-facing decisions. No new dead/detached systems found in this pass; every module resolves to a live reference.
- No behavioral bugs, contract changes, or leftover debug code were introduced by the docs review.

## Plan

Files touched:
1. `docs/.audit/docs-audit-2026-11-13.md` — created (this audit).
2. `docs/configuration.md` — corrected `AI_MODEL_NAME` required-vs-fallback wording.
3. `.env.example` — aligned `ELASTRAX_DB_SYNCHRONOUS` commented example with the `FULL` default.
4. `AGENTS.md` — repointed stale audit references; project-map reference already valid.
5. `.dockerignore` — dropped the nonexistent `AUDIT.md` line.
6. `docs/.agent/project-map.md` — verified accurate; no change needed.
