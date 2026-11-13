# Documentation Audit — 2026-11-12

Scope: whole repository. Focus: none. Branch: `maint/2026-11-12-full-pass`.

Baseline checks: `bun run lint` clean, `bun run typecheck` clean, `bun test --no-env-file test/` green, `bun run db:check` clean, `bun audit --audit-level=high` clean.

This pass re-verified every doc in `docs/` plus `README.md` against the code, following up on the 2026-11-11 audit (which fixed architecture.md heading levels and the ModelRouter lazy-construction claim).

## Stale or Incorrect

1. **`README.md` §Webhooks** — Claims "Inbound webhooks are disabled unless explicitly enabled" but:
   - Code default: `readBoolean(env, 'WEBHOOK_ENABLED', true)` in `src/webhooks/config.ts` — default is **enabled**.
   - `.env.example` line 277: `WEBHOOK_ENABLED=true` (not commented out).
   - Action: reword to say webhooks are enabled by default and can be disabled with `WEBHOOK_ENABLED=false`; keep the opt-in framing for secrets and external exposure.

2. **`README.md` §Operations** — Lists `GET /health` and `GET /live` as "minimal liveness only" and `GET /ready` as "compatibility readiness hook". Both are accurate per `src/webhooks/WebhookServer.ts`, but the `/health`/`/live` distinction is not meaningful in code (both return the same payload). No code change needed; clarify in docs.

## Missing Coverage

3. No consolidated configuration reference. `.env.example` is complete and annotated, but there is no doc that lists every env var with type, default, required/optional, and purpose, derived from `src/config/env.ts`, `src/webhooks/config.ts`, `src/config/runtime.ts`, and `src/utils/DigestService.ts`.

4. No dedicated document for background services: `Scheduler`, `DigestService`, `HealthMonitor`, `InboxService`, `OutboxService`, `MediaService`, `NotificationSubscriptionService`, `ConfigService`, `AuthService`, `EmbeddingService`. Each is mentioned in passing in `docs/architecture.md` but none has usage documentation, config, or lifecycle detail.

5. No admin dashboard API documentation beyond the route table in `docs/api.md`. Auth flow, session cookie, CSRF header, and the `/admin/api/*` action surface are not documented anywhere.

6. No database schema document. `src/db/schema.ts` tables and columns are not described; migration lifecycle is covered in `docs/room-identity-migration.md` and `docs/deployment.md` but not the schema itself.

7. `docs/tools.md` is a good overview but does not document every tool's parameters, permissions, mutability, or cost. `src/tools/registry.ts` is the source of truth but no doc consumes it.

8. No dedicated document for the `MessageContext` interface (every field, provider responsibilities, optional vs required).

9. No error-handling conventions document. Error types (`ProviderError`, `AIProtocolError`, `WebhookRequestError`, `TurnBudgetExceededError`, `FlowVersionConflictError`, etc.) are scattered across code; only `docs/architecture.md` §15 mentions them briefly.

10. No logging conventions document beyond one paragraph in `docs/architecture.md` §15 and `docs/setup.md` §Logging.

11. No plugin system document beyond two lines in README and `docs/tools.md` §Execution model. `src/plugins/manifest.ts`, the manifest admission rules, `PLUGIN_ALLOWED_PERMISSIONS`, and `ENABLE_PLUGIN_RELOAD` are not documented as a feature.

## Structural Problems

12. None beyond item 1. All cross-references in README/docs resolve. Layout is appropriate; no reorganization needed.

## Found While Documenting

- `src/index.ts` lines 102–106 contain a stale comment ("…was never armed in production") contradicted by line 109, which wires `runStartupCoverageScan`. Code doc comment only; flagged for the code owner, not a docs file.
- `modal/` exists on disk but is untracked in git and not part of the bot or CI; README's statement is accurate.

## Plan — files to touch

| File | Change | Reason |
|------|--------|--------|
| `README.md` | Fix webhook enabled/disabled contradiction | Code default is `true`; docs say disabled unless enabled |
| `docs/architecture.md` | Add services overview + verify heading consistency | Missing services not listed |
| `docs/configuration.md` | Create | Consolidated env-var reference derived from code |
| `docs/services.md` | Create | Document all background services with config and lifecycle |
| `docs/admin-dashboard.md` | Create | Admin auth, session cookie, CSRF, `/admin/api/*` routes |
| `docs/database.md` | Create | Schema tables, migration lifecycle, lease behavior |
| `docs/error-handling.md` | Create | Error types, codes, retryability, startup validation |
| `docs/logging.md` | Create | Pino usage, levels, transport, child loggers |
| `docs/plugins.md` | Create | Plugin manifest, admission, permissions, reload |
| `docs/message-context.md` | Create | Every `MessageContext` field, provider contract |
| `docs/tools.md` | Extend | Tool parameters, permissions, mutability, cost per tool |
| `docs/.audit/docs-audit-2026-11-12.md` | Create this audit | Record findings and plan |

Progress checklist:
- [x] Baseline checks recorded (green)
- [x] Audit file created
- [x] README.md webhook contradiction fixed
- [x] docs/configuration.md created
- [x] docs/services.md created
- [x] docs/admin-dashboard.md created
- [x] docs/database.md created
- [x] docs/error-handling.md created
- [x] docs/logging.md created
- [x] docs/plugins.md created
- [x] docs/message-context.md created
- [x] docs/tools.md extended
- [x] docs/architecture.md services overview added
- [x] docs/README.md index updated
- [x] Verification: lint clean, typecheck clean, 1592 tests pass, db:check clean, markdown links resolve

## Flagged for your decision

- None. All changes are doc-only and derived from verified code.

## Verification

- `bun run lint` — eslint `--max-warnings=0`: clean
- `bun run typecheck` — `tsc --noEmit`: clean
- `bun test --no-env-file test/` — 1592 pass / 0 fail (128 files)
- `bun run db:check` — clean
- Markdown links in docs/README.md all resolve to existing files