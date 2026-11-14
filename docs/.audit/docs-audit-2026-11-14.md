# Documentation audit — 2026-11-14

Scope: whole repo. Focus: none. Branch: `maint/2026-11-14-full-pass`.
Prior pass: `docs-audit-2026-11-13.md` (finished clean). This pass re-audited against
code that moved after it: the 2026-11-14 maintenance fixes (discord resume, streaming
fallback, provider shutdown drain, reminder deferrals, FlowHandler dedupe, SSE cancel,
inbox-completion logging).

## Baseline (verified before changes)

| Check | Command | Result |
|---|---|---|
| Lint | `bun run lint` (`--max-warnings=0`) | clean |
| Typecheck | `bun run typecheck` | clean |
| Tests | `bun test --no-env-file test/` | **1598 pass / 0 fail**, 128 files |
| Schema | `bun run db:check` | "Everything's fine" |
| Focused | `bun test --no-env-file test/PingTool.test.ts test/Scheduler.test.ts` | 15 pass / 0 fail |
| CI triage | `bun run scripts/ciDiagnostics.ts --limit 8` | 4 skipped, 4 `no_step_scheduling_failure` (account-side) |

## Method

Compared every doc under `docs/`, plus `README.md` and `AGENTS.md`, against `src/`,
`scripts/`, `.github/workflows/`, `Dockerfile`, `docker-compose.yml`, `package.json`,
`.env.example` and `drizzle/`. Every environment variable read by code was extracted
mechanically (`env.X`, `env['X']`, `read*Env(env, 'X')`, `process.env.X`) and diffed
against `docs/configuration.md` and `.env.example`. Claims about timers, leases,
retry counters, provider status, routes and versions were checked against the
implementing module.

## 1. Stale or incorrect

| # | Location | Issue | Evidence | Action |
|---|----------|-------|----------|--------|
| 1 | `docs/configuration.md` §3 (`AI_<NAME>_MODEL`) | Says the default for every provider is `meta-llama/Meta-Llama-3-8B-Instruct`. Multi-provider mode actually falls back to `gpt-4o-mini` for unknown names. | `src/config/llm.ts` `PROVIDER_DEFAULT_MODELS[name] \|\| 'gpt-4o-mini'`; the llama default is single-provider only | Reword the default column |
| 2 | `docs/configuration.md` §3 (`AI_<NAME>_SUPPORTS_TOOLS`, `AI_<NAME>_STREAM_USAGE`) | Both rows say "validated but not consumed by resolver". Both are consumed with a `true` default. | `src/utils/ModelRouter.ts` `supportsTools: readCapability('SUPPORTS_TOOLS', true)`, `includeStreamUsage: readCapability('STREAM_USAGE', true)` | Correct the default/purpose cells |
| 3 | `docs/api.md` (admin section) | Says "the deployment example in `docs/deployment.md` only proxies `/webhook`, which leaves the dashboard unreachable." `deployment.md` now has a separate `/admin` proxy block. | `docs/deployment.md` §"The admin dashboard needs its own proxy rule" | Rephrase as a requirement, not a gap in our own example |
| 4 | `docs/api.md` (replay) | "a future durable outbox will use the same ID as its idempotency key" — the outbox exists, and `AppRuntime.enqueueWebhook` registers it at boot. | `src/runtime/AppRuntime.ts:406` `registerEnqueuer(this.enqueueWebhook)`; `src/messaging/OutboxService.ts` `idempotencyKey` | Correct the tense and state that `X-Webhook-Id` is the delivery idempotency key |
| 5 | `docs/error-handling.md` (WhatsApp reconnect) | Names only close code `515` as triggering reconnect. The code reconnects on **every** disconnect reason except `DisconnectReason.loggedOut` (`401`). | `src/providers/whatsapp.ts:328` `shouldReconnect = statusCode !== DisconnectReason.loggedOut && …` | Describe the real rule; keep `515` as an example |
| 6 | `.env.example` (webhook section) | Comment says "Webhook intake is opt-in." The code default and the file's own `WEBHOOK_ENABLED=true` are the opposite. | `src/webhooks/config.ts:192` `readBoolean(env, 'WEBHOOK_ENABLED', true)` | Reword: enabled by default, set `false` to disable |
| 7 | `.env.example` (media capability flags) | Says "image_url is always sent to all providers". `AI_SUPPORTS_IMAGE` defaults to `true` but can be turned off. | `src/utils/ModelRouter.ts` `readCapability('SUPPORTS_IMAGE', true)` | Reword: sent by default, can be disabled |
| 8 | `docs/ci-diagnostics.md` §"Current repository state" | Dated snapshot ("last green CI run 2026-08-25", "2 skipped, 2 no_step…") that no longer describes the repo. | `bun run scripts/ciDiagnostics.ts --limit 8` on 2026-11-14 → 4 skipped, 4 `no_step_scheduling_failure` | Replace with a current, clearly dated snapshot and a "re-run this instead of trusting it" note |
| 9 | `docs/.agent/project-map.md` | Recorded at `b4ad7af`, lists a nonexistent `src/agent/prompts.ts`, and omits `src/admin`, `src/ai`, `src/config`, `src/flows`, `src/types`. | `ls src/agent` (no `prompts.ts`); `find src -maxdepth 1` | Update the recorded commit/date and the tree |
| 10 | `docs/tools.md` (Owner Admin row) | Lists only `/broadcast`, `/leave`. The tool's aliases also include `/owner`, `/botleave`, `/pinout` and actions `system_info`. | `src/tools/OwnerTool.ts` `aliases = ['owner','broadcast','leave','botleave','pinout']` | Complete the row |

## 2. Missing coverage

| # | Location | Issue | Action |
|---|----------|-------|--------|
| 11 | `docs/configuration.md` | Claims to list *every* variable, but omits variables the code reads: `MESSAGE_QUEUE_PER_ROOM_LIMIT/GLOBAL_LIMIT/MAX_AGE_MS/SHUTDOWN_GRACE_MS`, `AI_MAX_RESPONSE_BYTES`, `AI_MAX_TOOL_CALLS`, `AI_MAX_PARALLEL_TOOLS`, `AI_MAX_TOOL_RESULT_BYTES(_TOTAL)`, `AI_OPERATIONAL_CONTEXT_LIMIT`, `AI_MAX_TOKENS_PARAM`, `AI_MAX_OUTPUT_TOKENS`, `AI_SUPPORTS_PARALLEL_TOOLS`, `ALLOW_TOOLS`, `EMBEDDING_*`, `TTS_*`, `MENFESS_TARGETS`, `WA_AUTH_IMPORT_DIR`, `LOG_ROOT`, and the `RETENTION_*` group. | Add sections for the turn budget, message queue, embeddings, TTS, menfess, WhatsApp legacy auth import and operations; point retention at `docs/database.md` (single home) |
| 12 | `.env.example` | Missing `AI_MAX_OUTPUT_TOKENS` (read by `ModelRouter`) and `LOG_ROOT` (read by `OwnerTool`). | Add commented entries with their real defaults |
| 13 | `docs/services.md` | Reminder delivery semantics are undocumented: recurring reminders keep their `remindAt` anchor across retries (`preserveSchedule`), deferrals (no sender for the platform) use their own counter with `MAX_DEFER_ATTEMPTS = 24` and never retire a recurring row, send failures stop at `MAX_DELIVERY_ATTEMPTS = 5`, and the stale-claim window is `max(2 min, SCHEDULED_TASKS_TIMEOUT_MS)`. | Add a "Reminder delivery and retries" subsection |
| 14 | `docs/architecture.md` | No description of provider status semantics (`stopped/starting/running/backoff/not_configured/error`), `isOperational`, or that Discord restores `running` after a gateway resume. | Add a short provider-lifecycle paragraph |
| 15 | `docs/architecture.md` | WhatsApp's background history sync (`syncHistoricalDatabase`) writes imported history into the database and is listed nowhere. | Mention it with the other background work |
| 16 | `docs/setup.md` | Says Baileys auth state "is stored under the writable data directory", but it is stored in the SQLite database (`useDBAuthState`), and the legacy import path (`WA_AUTH_IMPORT_DIR`) is not mentioned. | Correct the storage location and mention the one-time import |
| 17 | `docs/configuration.md` §17, `docs/architecture.md` §17 | Say the feedback eval log is written when `FEEDBACK_LOG_ENABLED=true` (implying opt-in, default false). The code is opt-out: the log is **on** unless the value is `0`/`false`/`no`/`off`. | Correct both to "on by default, disable with false" |
| 18 | `.env.example` | Lists `FEEDBACK_LOG_PATH` twice with two different defaults (`./data/feedback.log` and `data/feedback.jsonl`; the code default is the latter), and shows `PLUGIN_ALLOWED_PERMISSIONS=""` although the default is `user,premium`. | Drop the stale duplicate and correct the plugin example |
| 19 | `docs/configuration.md` §13 | Lists `JELLYFIN_PUBLIC_LIBRARY`, `MEDIA_PUBLIC_LIBRARY`, `ENABLE_MEDIA_LIBRARY` and `JELLYFIN_PUBLIC_MODE` as four independent flags. They are aliases for one switch (any true enables unbound `/library` browsing). | Collapse to one row that says so |
| 20 | `docs/configuration.md` §11, §5 | `SEARXNG_URL` default is documented as a placeholder URL, but the code default is unset (tool disabled); the placeholder is only `.env.example`. `LONG_TERM_MEMORY` is documented as "no global env var" although `ConfigService` reads it as a global default. | Correct both rows |

## 3. Structural problems

None. One canonical home per topic holds: configuration in `docs/configuration.md`,
retention knobs in `docs/database.md`, routes in `docs/api.md`, service lifecycle in
`docs/services.md`. The doc index (`docs/README.md`) resolves every file it lists.

## 4. Found while documenting (code observations, not fixed)

- `src/admin/data.ts` `CONFIG_ALLOWLIST` includes `EMBEDDING_ENDPOINT`, which no code
  reads (`EmbeddingService` reads `EMBEDDING_API_URL`). The dashboard therefore shows a
  key that is always unset. Harmless, but it should be `EMBEDDING_API_URL`.
- `getTurnBudgetConfig` (`src/config/runtime.ts`) accepts `AI_MAX_TOOL_CALLS` up to 32 and
  `AI_MAX_PARALLEL_TOOLS` up to 16, but `TurnBudget` clamps both to 8 and 4. Values above
  those ceilings are silently ignored. Documented as "can only lower the ceiling"; if the
  wider range is intended, the clamp in `src/ai/turnBudget.ts` needs raising.
- The comment in `Scheduler.deferOrRetire`'s caller still says the deferral path "is
  retired after `MAX_DELIVERY_ATTEMPTS`"; the code now uses `MAX_DEFER_ATTEMPTS = 24` and
  never retires a recurring reminder. The behaviour is correct and documented in
  `docs/services.md`; only the code comment has drifted.
- `docs/configuration.md` previously described `AI_<NAME>_STREAM_USAGE` as inert; the
  variable is live in `ModelRouter`. Documentation corrected, no code change needed.
- No behavioral bug, contract change or dead endpoint was found in this pass. The
  deferred items in `docs/maintenance/audit-2026-11-14.md` (IG-01…IG-10, OI-03…OI-10)
  remain open by design.

## Plan

Files touched:

1. `docs/.audit/docs-audit-2026-11-14.md` — created (this audit).
2. `docs/configuration.md` — correction + new sections (items 1, 2, 11).
3. `.env.example` — webhook/image wording, `AI_MAX_OUTPUT_TOKENS`, `LOG_ROOT` (items 6, 7, 12).
4. `docs/api.md` — admin proxy note and outbox idempotency wording (items 3, 4).
5. `docs/error-handling.md` — WhatsApp reconnect rule (item 5).
6. `docs/services.md` — reminder delivery/retry semantics (item 13).
7. `docs/architecture.md` — provider status lifecycle and history sync (items 14, 15).
8. `docs/ci-diagnostics.md` — current snapshot (item 8).
9. `docs/.agent/project-map.md` — commit/date and tree (item 9).
10. `docs/tools.md` — Owner Admin aliases and media tool aliases (item 10).
11. `docs/setup.md` — WhatsApp auth storage location and legacy import (item 16).

`docs/.agent/project-map.md` is the single source for the directory map; other docs link
to it rather than restating it.

Progress:

- [x] Audit written
- [x] `docs/configuration.md`
- [x] `.env.example`
- [x] `docs/api.md`
- [x] `docs/error-handling.md`
- [x] `docs/services.md`
- [x] `docs/architecture.md`
- [x] `docs/ci-diagnostics.md`
- [x] `docs/.agent/project-map.md`
- [x] `docs/tools.md`
- [x] `docs/setup.md`
- [x] Validation re-run

## Verification (after changes)

| Check | Command | Result |
|---|---|---|
| Full gate | `bun run check` (lint → typecheck → test → db:check) | pass: lint clean, typecheck clean, **1598 pass / 0 fail**, `db:check` clean |
| Focused | `bun test --no-env-file test/PingTool.test.ts test/Scheduler.test.ts` | 15 pass / 0 fail |
| CI triage | `bun run scripts/ciDiagnostics.ts --limit 8` | 4 skipped, 4 `no_step_scheduling_failure` |
| Links | relative-link check across `README.md`, `AGENTS.md`, `docs/**/*.md` | 0 broken |
| Env coverage | code-extracted env names vs `docs/configuration.md` / `.env.example` | every variable the code reads is documented either in `configuration.md` or at its canonical home (`RETENTION_*` in `database.md`); only framework flags (`BUN_TEST`, `VITEST`), `HOME`, and internal `DB_*_PATH` overrides are omitted by design |

Could not verify:

- Account-side GitHub Actions scheduling/billing: CI is still not allocating runners. Every repository gate
  above was proven locally instead.
- Real provider connections (WhatsApp QR, Discord gateway, Telegram polling): the test harness throws on
  network access, so provider lifecycle claims were verified by reading the implementations.
- `docker compose build` / container smoke: not run in this pass (no Docker daemon assumed). The Dockerfile
  and Compose claims were checked by reading both files against `docs/deployment.md`.
