# Documentation audit — 2026-11-15

Scope: whole repo. Focus: none. Branch: `maint/2026-11-15-full-pass`.
Prior pass: `docs-audit-2026-11-14.md` (finished clean). The 2026-11-15 maintenance
pass changed behaviour after that documentation pass (`efd9118`…`577f7db`: provider
admission, admin body caps, plugin reload, KB permissions, streaming preview, digest,
health timers, identity merge). This pass re-audited the docs against that code.

## Baseline (verified before changes)

| Check | Command | Result |
|---|---|---|
| Full gate | `bun run check` (lint → typecheck → test → `db:check`) | pass: lint clean, typecheck clean, **1645 pass / 0 fail**, 131 files, `db:check` clean |
| CI triage | `bun run scripts/ciDiagnostics.ts --limit 8` | 4 skipped, 4 `no_step_scheduling_failure` (account-side) |

## Method

Compared every doc under `docs/`, plus `README.md`, `AGENTS.md` and `.env.example`,
against `src/`, `scripts/`, `.github/workflows/`, `Dockerfile`, `docker-compose.yml`,
`package.json`, and `drizzle/`. Environment variables read by code were extracted
mechanically and diffed against `.env.example` and `docs/configuration.md`. Claims
about roles, provider lifecycle, admin routes, tool metadata, timers, retry counters
and route handling were checked against the implementing module.

## 1. Stale or incorrect

| # | Location | Issue | Evidence | Action |
|---|----------|-------|----------|--------|
| 1 | `docs/configuration.md` §8, `docs/plugins.md` §Permissions, `.env.example` (Roles), `docs/.agent/project-map.md` §Tool Calling | All state that role levels are ordered (`user < premium < admin < owner`) and imply `premium` satisfies `admin`. The satisfier requires the **exact** role: only `owner` is universal and `user` is implicit. | `src/core/roleAccess.ts` `roleSatisfies`: `held.includes(required)`, with `user` and `owner` special cases | Correct all four; the numeric defaults still grow with the role name, so state that instead of a permission ladder |
| 2 | `docs/configuration.md` §12 (`WEBHOOK_ENABLED`) | Says it disables "the webhook listener entirely". The listener always binds; only `POST /webhook*` answers `503`, while `/health`, `/live`, `/ready`, `/metrics` and `/admin` keep serving. | `src/runtime/AppRuntime.ts:411` always calls `webhookServer.start()`; `src/webhooks/WebhookServer.ts:485` rejects POST intake when disabled | Reword the row |
| 3 | `docs/services.md` §AppRuntime lifecycle step 4 | Says a late-connecting provider "is still included in `activeProviders` so late-connecting providers receive traffic". A provider whose `start()` rejected is **not** in `activeProviders`; it is wired later by `reconcileProviderAdmission()` and included by the live `isOperational` check in `operationalProviders()`. | `src/runtime/AppRuntime.ts:372` (boot snapshot), `:439` (`operationalProviders`), `:704` (`reconcileProviderAdmission`) | Describe the real mechanism |
| 4 | `docs/api.md` (operational endpoints), `README.md` §Operations | `GET /ready` is documented as returning `{"status":"ready"}` only. The payload also carries `version` and `releaseTag`, and the `503` body is `{"status":"not_ready",…}`. | `src/webhooks/WebhookServer.ts:425` (`payload`), `:460-465` | Show the real bodies |
| 5 | `docs/api.md` (admin action row), `docs/admin-dashboard.md` §Dashboard actions | Actions are named generically. Exact paths are stable and useful to an operator. | `src/admin/routes.ts:294-306` | List the four exact paths |
| 6 | `docs/admin-dashboard.md` | No mention of the admin request-body caps or the per-IP login throttle added in this pass. | `src/admin/routes.ts:61-62` (`4 KiB` login, `64 KiB` action); `src/admin/auth.ts` (`LoginThrottle`: 5 attempts / 60 s / IP), `MAX_SESSIONS = 32` | Add a request-bounds subsection |
| 7 | `docs/plugins.md` §Reloading plugins, `docs/tools.md` (§Reload Plugins, execution model) | `/reload` is described as reloading "plugin tools". It now also **re-evaluates edited plugin source**: each load imports with a fresh cache-busting specifier, and load reports are replaced per load rather than appended. | `src/tools/registry.ts:511` (`pluginImportGeneration`), `:515` (`pluginReports.length = 0`) | State the re-evaluation and per-load reports |
| 8 | `docs/tools.md` mutating table (`owner_admin`) | Row lists only `/broadcast`, `/leave`; the tool also owns `/owner`, `/botleave`, `/pinout`. | `src/tools/OwnerTool.ts:68` | Complete the row |
| 9 | `docs/tools.md` §Execution model | Progress icons are documented as ✅/❌; a running step is ⏳. | `src/agent/toolProgress.ts:174` | Add the running icon |
| 10 | `README.md` §Security notes | Tells operators not to grant `allow_all` permissions. No such permission exists; the real roles are `user`, `premium`, `admin`, `owner`. | `src/core/roleAccess.ts`, `src/plugins/manifest.ts`, `src/utils/AuthService.ts` | Replace with the real role model |
| 11 | `docs/.agent/project-map.md` | Recorded at `5694063`; the tree predates the 2026-11-15 changes. Roles line lists a nonexistent `moderator`. | `git log` (HEAD `577f7db`); `src/core/roleAccess.ts` | Update commit/date, tree notes, roles |
| 12 | `docs/ci-diagnostics.md` §Current repository state | Snapshot dated 2026-11-14. | Re-ran `bun run scripts/ciDiagnostics.ts --limit 8` on 2026-11-15: same 4 skipped / 4 `no_step_scheduling_failure` | Date it 2026-11-15 |
| 13 | `docs/plugins.md` §Permissions, `docs/configuration.md` §22, `.env.example` (Plugins) | `PLUGIN_ALLOWED_PERMISSIONS` is described as set membership ("plugins declaring a permission not listed are refused"). `resolveAllowedPluginPermissions` treats the list as a **ceiling**: the highest level listed admits every lower level, so `PLUGIN_ALLOWED_PERMISSIONS=admin` also admits `user`/`premium` plugins. | `src/plugins/manifest.ts:160-170` | Describe the ceiling rule, separately from the exact-role runtime check |
| 14 | `docs/tools.md` (opt-in table, Speak row) | Says `SpeakTool` requires every `TTS_*` variable. `isTtsConfigured` requires a key and base URL, plus a voice only for ElevenLabs. | `src/utils/tts.ts:103-108` | Correct the registration condition |
| 15 | `docs/api.md` (route table note) | Says "every POST route requires `Content-Type: application/json`". Admin POST routes have no content-type gate; only the webhook routes do. | `src/admin/routes.ts` `readJsonObjectBody`; `src/webhooks/WebhookServer.ts` `isJsonContentType` | Scope the statement to webhook routes |
| 16 | `AGENTS.md`, `docs/database.md`, `docs/scripts.md` | All say `db:migrate` takes a backup first. `scripts/dbBackup.ts` `runMigrate` only calls `ensureDatabaseSchema`; it never backs up. | `scripts/dbBackup.ts:42-54` | Say it does not back up; run `db:backup` first |
| 17 | `docs/tools.md` (Find Tools alias, tool-parameter note) | Gives the command as `/findtools`. The tool is named `find_tools`, has no aliases, and commands are not underscore-normalized. | `src/tools/FindToolsTool.ts:29-32`; `src/tools/registry.ts:361-366` | Correct to `/find_tools` |
| 18 | `docs/database.md`, `docs/architecture.md`, `.env.example`, `docs/canary-runbook.md` | Retention is described as deleting "terminal deliveries"/"terminal delivery records". No delivery table exists (dropped in `0024`); `RETENTION_TERMINAL_DELIVERY_DAYS` governs terminal **and stale** inbox/outbox rows. The fixed 7-day clearing of `raw_message`/`media_path`/`mime_type` is undocumented. | `src/db/retention.ts:158-212` (`inbox`, `inboxStale`, `outbox`, `outboxStale`, `clearRawMessageBatches`) | Correct the wording and document the 7-day payload clear |
| 19 | `docs/configuration.md` (`LOG_ROOT`) | Describes a four-step "first existing" chain. The `$HOME` path is returned without an existence check. | `src/tools/OwnerTool.ts:37-44` | State the real fallback order |
| 20 | `docs/tools.md` mutating table | Omits `memory` (`local-write`) and `role` (`admin`), which declare their mutability on the tool rather than in `MUTABILITY_OVERRIDES`; the table reads as if it were complete. | `src/tools/MemoryTool.ts:126`, `src/tools/RoleTool.ts:96` | Add both rows |
| 21 | `README.md`, `docs/deployment.md`, `docs/setup.md` | Say yt-dlp is checksum-verified. Only FFmpeg has a SHA-256 check; yt-dlp is installed by pinned version with pip. | `Dockerfile:5-28` (FFmpeg SHA), `:54` (pip install) | Distinguish the two |
| 22 | `docs/services.md` service list, `docs/architecture.md` §13 | Omit `IdentityService` and `ServiceBindingService`, both live on-demand services used by the agent. | `src/utils/IdentityService.ts`, `src/utils/ServiceBindingService.ts` | Add them |

## 2. Missing coverage

| # | Location | Issue | Action |
|---|----------|-------|--------|
| 23 | `docs/message-context.md` | Interface table omits `signal` (the per-turn `AbortSignal`) and the descriptor's `providerId`. | Document both |
| 24 | `docs/architecture.md` §13, `docs/database.md` | Retention is documented as unconditional; AppRuntime arms it only when a durable messaging store is present. | Note the condition |
| 25 | `docs/provider-staging-matrix.md`, `docs/ci-diagnostics.md` | Listed harness/triage flags omit `--platform` and `--branch`/`--event`. | Add them |
| 26 | `docs/architecture.md` §3 | Provider lifecycle omits `reconcileProviderAdmission()` — the self-healing path that registers senders for a provider that connected after boot. | Add it to the lifecycle paragraph |
| 27 | `docs/architecture.md` §4 | Streaming behaviour introduced/confirmed this pass is undocumented: the preview strips a partially streamed `think` block (reasoning never reaches the user) and an intermediate streamed bubble that the progress tracker does not adopt is finalised instead of left with a dangling cursor. | Document both under the agent loop |
| 28 | `docs/error-handling.md` | The pre-reply failure path is undocumented: a failure between room lookup and slash routing reacts ❌, replies with `agent.internal_error`, rethrows so the inbox row is not marked completed, records `recordMessageError()`. `withTimeout`/`withCancellableTimeout` settlement semantics are also worth one line. | Add a "Message-handling failures" and a "Timeouts" subsection |
| 29 | `docs/configuration.md` §24, `.env.example` | `ELASTRAX_TEST_FFMPEG_DIR` is read by `src/utils/FFmpegConverter.ts` and set by the test harness, but it is absent from `.env.example` (only documented in `configuration.md`). | Add the commented entry |
| 30 | `.env.example` | `PLUGIN_ALLOWED_PERMISSIONS` and `ADMIN_COOKIE_INSECURE` each appear twice in different sections with different commented values. | Keep one canonical occurrence per key |

## 3. Structural problems

None. One canonical home per topic holds: configuration in `docs/configuration.md`,
retention knobs in `docs/database.md`, routes in `docs/api.md`, dashboard detail in
`docs/admin-dashboard.md`, service lifecycle in `docs/services.md`, directory map in
`docs/.agent/project-map.md`. Every file in the `docs/README.md` index exists.

## 4. Found while documenting (code observations, not fixed)

- `src/admin/data.ts:429` `CONFIG_ALLOWLIST` still contains `EMBEDDING_ENDPOINT`, which
  no code reads (`EmbeddingService` reads `EMBEDDING_API_URL`). The dashboard shows a
  key that is always unset. Should be `EMBEDDING_API_URL`. (Carried over from the
  2026-11-14 audit; unchanged.)
- `src/tools/registry.ts` `COMMAND_POLICIES` still contains rows for `language`,
  `config` and `owner_admin.leave` that the LLM tool-call path never consults; per-action
  authorization is enforced only on the slash path (recorded as IG-14 in the 2026-11-15
  maintenance audit). The dead rows are flagged there, not removed, because the policy
  surface is public.
- `src/utils/Scheduler.ts:387` comment still says a deferral path is "retired after
  `MAX_DELIVERY_ATTEMPTS`", while the code uses `MAX_DEFER_ATTEMPTS = 24` and never
  retires a recurring reminder. Behaviour is correct and documented in
  `docs/services.md`; only the comment has drifted.
- The inbox retry machinery (`InboxService.fail`/`recoverStranded`) still has no
  consumer that selects a failed row (IG-11). `docs/error-handling.md` therefore
  describes dead-lettering as a state, not as a re-run. Enabling real retries changes
  delivery semantics and needs a product decision.
- No behavioural bug, contract change or dead endpoint was found in this pass.

## Plan

Files touched:

1. `docs/.audit/docs-audit-2026-11-15.md` — created (this audit).
2. `docs/configuration.md` — role model, `WEBHOOK_ENABLED`, `ELASTRAX_TEST_FFMPEG_DIR` note.
3. `docs/plugins.md` — role model, reload re-evaluation and per-load reports.
4. `docs/architecture.md` — provider reconciliation, streaming preview details, service list, retention wording.
5. `docs/services.md` — late-connecting provider admission, missing services, retention condition.
6. `docs/api.md` — `/ready` bodies, admin action paths and bounds, POST content-type scope.
7. `docs/admin-dashboard.md` — body caps, login throttle, session cap, exact action names.
8. `docs/error-handling.md` — pre-reply failures, timeout settlement, inbox retry note.
9. `docs/tools.md` — `owner_admin`/`memory`/`role` rows, `/find_tools`, `/reload`, progress icon.
10. `docs/database.md` — retention wording, raw-payload clearing, `db:migrate` backup correction.
11. `docs/message-context.md` — `signal`, descriptor `providerId`.
12. `docs/ci-diagnostics.md` — snapshot date and flags.
13. `docs/provider-staging-matrix.md`, `docs/deployment.md`, `docs/setup.md`, `docs/canary-runbook.md` — flags, yt-dlp checksum, retention wording.
14. `docs/.agent/project-map.md` — commit/date, roles.
15. `.env.example` — duplicate keys, `ELASTRAX_TEST_FFMPEG_DIR`, role/plugin/retention comments.
16. `README.md`, `AGENTS.md` — `/ready` payload, role model, `db:migrate` backup, yt-dlp.

Progress:

- [x] Audit written
- [x] Role model corrected across docs and `.env.example`
- [x] `docs/configuration.md`
- [x] `docs/plugins.md`
- [x] `docs/architecture.md`
- [x] `docs/services.md`
- [x] `docs/api.md`
- [x] `docs/admin-dashboard.md`
- [x] `docs/error-handling.md`
- [x] `docs/tools.md`
- [x] `docs/database.md`
- [x] `docs/message-context.md`
- [x] `docs/ci-diagnostics.md`
- [x] `docs/provider-staging-matrix.md`
- [x] `docs/deployment.md`, `docs/setup.md`, `docs/canary-runbook.md`
- [x] `docs/.agent/project-map.md`
- [x] `.env.example`
- [x] `README.md`, `AGENTS.md`
- [x] Validation re-run

## Verification (after changes)

| Check | Command | Result |
|---|---|---|
| Full gate | `bun run check` | pass: lint clean, typecheck clean, **1645 pass / 0 fail**, `db:check` clean |
| Docs links | relative-link scan across `README.md`, `AGENTS.md`, `docs/**/*.md` | all resolve |
| Doc paths | every `src/…`, `scripts/…`, `test/…`, `drizzle/…`, `.github/…` path named in a doc exists | all resolve |
| Package scripts | every `bun run <script>` named in a doc exists in `package.json` or is a real file | all resolve |
| Env coverage | code-extracted env names (including `integerEnv`/`integerSetting` helper reads) vs `.env.example` / `docs/configuration.md` | only framework/test-internal keys omitted by design (`BUN_TEST`, `VITEST`, `HOME`, `DB_*_PATH`) |
| CI triage | `bun run scripts/ciDiagnostics.ts --limit 8` | 4 skipped, 4 `no_step_scheduling_failure` |

A second sweep re-read every claim against the implementing module rather than against
the previous audit. That sweep produced items 16–30 above; the most consequential was the
long-standing "`db:migrate` takes a backup first" claim, which no version of the script
ever supported.

Could not verify:

- Real provider connections (WhatsApp QR, Discord gateway, Telegram polling): the test
  harness throws on network access, so provider lifecycle claims were verified by
  reading the implementations and the provider staging harness.
- GitHub Actions execution: runners are still not allocated, so the CI gate itself
  could not run; every repository gate was proven locally.
- `docker compose build` / container smoke: not run in this pass (no Docker daemon
  assumed). `Dockerfile` and `docker-compose.yml` claims were checked by reading both
  against `docs/deployment.md`.
