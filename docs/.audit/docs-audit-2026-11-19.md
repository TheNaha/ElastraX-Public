# Documentation audit — 2026-11-19

Scope: whole repo. Focus: none. Branch: `main`, HEAD `beef557`.
Prior pass: `docs-audit-2026-11-18.md` (content synced at `88ff240`, 2026-11-18).

The previous documentation pass synced the docs at `88ff240`. Since then the
tree gained the end of the fifth maintenance pass (`ef5af08`), the fourth/fifth
review follow-ups (`d74eac0`, `0dfb502`, …), and the deferred-investigation batch
(`846a899`..`beef557`). Only one commit in that range touched living docs
(`391c00f`, "align two stale docs"), so this pass is the first to read the docs
against that code.

Second caveat: this checkout had **11 uncommitted files** from a maintenance
pass in flight when the audit began. That pass (documents from `7d70469`
through `9e16190`, audit `docs/maintenance/audit-2026-11-19.md`) committed while
this pass ran. Everything in §1–§3 was first read against `beef557`; §5 records
the re-check against the new `HEAD` and the extra corrections pass 6 forced.

## Method

- Diffed `88ff240..HEAD` for `src/`, `scripts/`, `drizzle/`, `.env.example` and
  read each commit's doc impact.
- Extracted every `process.env.*` / `process.env['*']` name from `src/**` and
  `scripts/**` and diffed it against `.env.example` (`commits`, no diff).
- Spot-checked documented defaults against `src/config/runtime.ts`,
  `src/config/env.ts`, `src/webhooks/config.ts`.
- Resolved every relative Markdown link (0 broken) and every `#anchor`
  (864 headings checked, 0 broken) and every `src/…`/`scripts/…`/`test/…`/
  `drizzle/…` path in living docs (0 broken; only three historical audit files
  name modules without a `.ts` suffix).
- Checked every `bun run <script>` name in the docs against `package.json`
  (all exist) and every script in `scripts/` against `docs/scripts.md`
  (all listed).
- Compared the registry tool list (`src/tools/registry.ts`) with
  `docs/tools.md` (31 tools, all documented) and the route sets
  (`POST_PATHS`/`GET_PATHS` plus the admin route table) with `docs/api.md`
  (all documented).

## 1. Stale or incorrect

| # | Location | Issue | Evidence | Action |
|---|---|---|---|---|
| 1 | `docs/architecture.md` (Process lifecycle, step 4) | Says `SIGINT`/`SIGTERM` **and** `uncaughtException`/`unhandledRejection` are installed before booting the runtime. Only the two signals are registered before the first `await` (so a long migration can be interrupted); the fatal-error handlers are registered just before `AppRuntime` is constructed, because making stray rejections fatal during module import would turn a benign warning into a boot crash-loop. Shutdown also closes the database only once schema work has finished. | `src/index.ts` (`process.on('SIGINT'…)` before the first `await`; `onFatalError` handlers after `FlowHandler.initialize()`; `databaseReady` guard in `shutdown`) | Rewrite the lifecycle steps |
| 2 | `docs/architecture.md` (Process lifecycle) | Omits that a signal that lands during startup (schema work, flow loading) makes `bootstrap()` fail with `Startup interrupted by shutdown signal` at the guard before the runtime is constructed, instead of starting providers against a closed handle, and omits that the default bootstrap wires `runStartupCoverageScan` (bounded, non-fatal). | `src/index.ts` (`if (shuttingDown) throw …`; `new AppRuntime({ runStartupCoverageScan })`; `a7c3514`) | Add both |
| 3 | `docs/api.md` (Replay and rate limits) | "IDs are retained in a bounded in-memory cache for `WEBHOOK_REPLAY_TTL_MS`" implies a full cache rejects new ids. At `WEBHOOK_REPLAY_MAX_ENTRIES` the oldest **completed** id is evicted and intake continues; only a cache whose every slot is an in-flight request answers `503`. The key is also `route` + `source` + `id`, joined with NUL, not the raw id. | `src/webhooks/utils.ts` `WebhookReplayCache.reserve`/`complete`; `src/webhooks/WebhookServer.ts` (`replayKey` → ```${route}\u0000${source}\u0000${id}```); `70d0d21`, `75cc3a3` | Describe eviction, the key parts, and the two `503` cases |
| 4 | `docs/tools.md` (Binding-gated tools) | Says the binding is resolved "only when a binding-gated tool is registered", i.e. only on the agent's LLM path. `/menu`, `/find_tools` and the slash listing now share one predicate (`src/tools/access.ts` `isToolAccessible`) and resolve the binding themselves when the context does not carry `ctx.hasBinding`. | `src/tools/access.ts`; `src/tools/MenuTool.ts`; `src/tools/FindToolsTool.ts`; `src/agent/index.ts` (`ctx.hasBinding`); `19e28c9`, `098bf5b`, `e87344a` | Rewrite the paragraph as "one predicate, four surfaces" |
| 5 | `docs/services.md` (Reminder delivery) | Missing the post-send bookkeeping rule: if the state write after a successful send fails, it is retried **once in place**; it is never treated as a send failure (which used to re-arm the row and deliver the message twice). If both writes fail the claim is left in place until it goes stale. | `src/utils/Scheduler.ts` (`stateRecorded` loop); `6aa0ba5`, `efc1f35` | Add a bullet |
| 6 | `docs/database.md` (Retention) | Says nothing about the timestamp normalisation or the indexes the pass depends on. Retention compares every cutoff through a `CASE` (legacy rows are still in seconds), so the cutoff is not a plain range seek; migration `0026` adds `messages(created_at)` / `reminders(created_at)` and both are in `REQUIRED_INDEXES`. | `src/db/retention.ts` `NORMALIZE_TS`; `drizzle/migrations/0026_retention_indexes.sql`; `44f813a` | One paragraph |
| 7 | `docs/architecture.md` (§4 Agent loop, tool execution) | Describes only "executes them securely and feeds the result back". The turn budget now charges only calls that pass permission and argument validation, a round runs the calls that still fit and reports the limit for the remainder, and the progress footer plans only the calls that will run. | `src/agent/index.ts` `executeToolCalls` (`readyCount`, `executableReady`, `addPlannedSteps(executableReady)`); `d68ee9a`, `d74eac0`, `79420aa` | Two sentences |
| 8 | `docs/message-context.md` (`messageType`, `hasMedia`) | Calls `messageType` a "canonical Baileys message type" although each provider maps to the shared vocabulary (`telegram.ts` `messageTypeOf` returns `imageMessage`/`videoMessage`/`stickerMessage`/…), and says `hasMedia` means image/video/audio/document. Discord stickers (which arrive as `message.stickers`, not attachments), Telegram `animation`/`video_note` and Telegram stickers now count as media too. | `src/providers/telegram.ts` `messageTypeOf`; `src/providers/discord.ts` `stickerSources`; `8cebe22`, `baf3e9b` | Correct the wording |
| 9 | `docs/admin-dashboard.md` (Dashboard actions) | Does not state the response contract. Actions answer `{ok:true,…}` with `200`, `{ok:false,message}` with `400`, and an unexpected exception is caught and reported in the same `{ok:false,message}` shape so the UI shows the reason instead of a bare status. | `src/admin/routes.ts` `handleAction`; `f2c05d4` | One paragraph |
| 10 | `docs/scripts.md` (Development helpers) | `scripts/push-to-public.sh` is described as "Push helper (manual)". It fetches `origin`, refuses to continue unless `gitleaks detect` passes, then pushes `main` to the `origin-public` remote. | `scripts/push-to-public.sh` | Say what it does and the required remote |

## 2. Missing coverage

| # | Location | Gap | Action |
|---|---|---|---|
| 11 | `docs/provider-staging-matrix.md` | Layer 2 (manual, real-provider) has sections for WhatsApp and Discord only. Telegram is a first-class provider with its own fixtures in Layer 1 (`--platform`), so the release procedure has no real-Telegram acceptance cells. | Add section C (Telegram) with cells derived from `src/providers/telegram.ts`, renumber cross-cutting to D, and state in the intro which platforms Layer 2 covers |
| 12 | `docs/architecture.md` (§4) | The forced text-only iteration after `AI_MAX_TOOL_ITERATIONS` is not described anywhere; it is what stops a turn that used its whole tool budget from ending in "internal error". | Add to the bullet from §1 item 7 |
| 13 | `docs/.agent/project-map.md` | Recorded commit is `10fc3b2`; the map's `src/tools/` and `src/utils/` lists predate `src/tools/access.ts` and `src/utils/toolAccess.ts`. | Update the commit and the symbol list |

## 3. Structural problems

None. Configuration stays in `docs/configuration.md`/`.env.example`, routes in
`docs/api.md`/`docs/admin-dashboard.md`, timers and delivery semantics in
`docs/services.md`, lifecycle in `docs/architecture.md`. No file moved.

## 4. Found while documenting (code observations, not fixed)

- **Maintenance pass 6 landed while this pass ran** (`7d70469`..`9e16190`,
  audit `docs/maintenance/audit-2026-11-19.md`). It fixes exactly the areas this
  document set describes, so §5 re-checked every affected sentence and updated
  six of them. No finding here is left open except the two decisions below.
- `src/admin/data.ts` `CONFIG_ALLOWLIST` listed `EMBEDDING_ENDPOINT`, which no
  code reads; pass 6 (I-07) replaced it with `EMBEDDING_API_URL`, so the config
  view now shows a variable that exists.
- `src/admin/routes.ts` maps an unexpected action exception to HTTP `400`
  (`handleAction` catch). The documented contract is behaviour, not a claim that
  `400` is the right status; a database failure arguably deserves `500`. Not
  changed, flagged for a decision. Pass 6 did not change it.
- `.env.example` ships active placeholders (`AI_MODEL_NAME`, `BOT_OWNER_JID`,
  `SEARXNG_URL`, `CONTEXT_MESSAGE_LIMIT`, `RATE_LIMIT_MESSAGES`, …), so a verbatim
  copy needs editing. That remains the documented "set at minimum" path.
- Docker/Compose behaviour was verified by reading `Dockerfile`,
  `docker-compose.yml` and `docs/deployment.md` (FFmpeg `n9.0` + published-digest
  check, yt-dlp `2026.08.19`); no Docker daemon is available here, so no build or
  container smoke was run.

## Plan

1. `docs/.audit/docs-audit-2026-11-19.md` — this audit.
2. `docs/architecture.md` — lifecycle handler ordering, interrupted-boot guard,
   coverage-scan wiring, tool-budget execution, forced text-only round.
3. `docs/api.md` — replay key composition, eviction at capacity, `503` cases.
4. `docs/services.md` — post-send state-write retry.
5. `docs/database.md` — retention predicate and `0026` indexes.
6. `docs/tools.md` — one access predicate across menu/find_tools/slash/LLM.
7. `docs/admin-dashboard.md` — action response contract.
8. `docs/message-context.md` — shared `messageType` vocabulary, media kinds.
9. `docs/scripts.md` — `push-to-public.sh` behaviour.
10. `docs/provider-staging-matrix.md` — Telegram acceptance section.
11. `docs/.agent/project-map.md` — recorded commit and new modules.

Progress:

- [x] Audit written
- [x] `docs/architecture.md`
- [x] `docs/api.md`
- [x] `docs/services.md`
- [x] `docs/database.md`
- [x] `docs/tools.md`
- [x] `docs/admin-dashboard.md`
- [x] `docs/message-context.md`
- [x] `docs/scripts.md`
- [x] `docs/provider-staging-matrix.md`
- [x] `docs/.agent/project-map.md`
- [x] Re-check against maintenance pass 6 (§5)
- [x] Validation re-run

## 5. Re-check after maintenance pass 6 (`7d70469`..`9e16190`)

| # | Location | What pass 6 changed | Doc action |
|---|---|---|---|
| 14 | `docs/services.md` | `AppRuntime.stop()` now memoises one teardown promise (`7d70469`); a caller during shutdown awaits it instead of getting an already-resolved promise, and `start()` waits before re-arming. `MessageQueue.resume()` undoes a stop, so a stop/start cycle no longer leaves `/ready` at 503 forever. | Rewrote the idempotence paragraph |
| 15 | `docs/error-handling.md` | `InboxService.claim(id, owner, { allowBackoff: true })` admits a provider redelivery of an event already in the ledger, despite the worker's own backoff. | Replaced "the `failed` state is terminal" with the exception and kept "no periodic retry driver" |
| 16 | `docs/database.md`, `docs/scripts.md` | Retention predicates now carry a plain `column < ?` so `messages`/`reminders`/`flow_sessions` are range-seeked; `message_inbox`/`message_outbox` still cannot be (`COALESCE` over two columns). `runRetention.ts` refuses a missing or unmigrated database (`I-01`, `I-04`). | Rewrote the retention paragraph; noted the guard in both command tables |
| 17 | `docs/admin-dashboard.md` | `isSameOrigin` accepts the first `X-Forwarded-Host` as a second candidate (`I-05`); the login throttle sweeps at most once per window (`I-06`). | Documented both |
| 18 | `docs/architecture.md` (§7) | The router treats a reasoning-only response — including a truncated open block — as empty, and a mid-stream fallback calls `onRestart` so the abandoned chunks are dropped (`C-08`). | One bullet |
| 19 | `docs/flows.md` | A stale/unhandled flow session is announced before it is cleared (`C-10`). | One bullet |
| 20 | `docs/database.md` (migration lease) | Pass 6 left the migration lease without a heartbeat (`I-03`, deferred): `migrate()` is synchronous, so a renewal timer in that thread cannot fire. | Nothing changed; the existing "if another process holds it, startup fails" stays accurate |

Pass-6 fixes with no doc impact (verified, no claim contradicted): Discord
reaction intents, WhatsApp round-video-note media, Telegram unban failure
reporting, `SpeakTool` signal handling, bounded embedding/transcription bodies,
batched auth-state reads, the single fixtures dumper, `CONTEXT_MESSAGE_LIMIT`
dropped from the unused turn-budget object, `latestMigration` in backup
manifests (already documented in the canary runbook), and `DiscordProvider.stop()`
awaiting `client.destroy()`.

## Verification (after changes)

| Check | Command | Result |
|---|---|---|
| Lint | `bun run lint` | clean (`--max-warnings=0`) |
| Typecheck | `bun run typecheck` | clean |
| Schema | `bun run db:check` | "Everything's fine" |
| Drift | `bun run db:generate` | "No schema changes, nothing to migrate" (git status of `drizzle/` and `src/db/schema.ts` unchanged) |
| Tests | `bun test --no-env-file test/` | **1819 pass / 0 fail**, 136 files, 5600 `expect()` calls |
| Migration smoke | `bun test --no-env-file test/migration.test.ts` | 9 pass / 0 fail |
| Hermetic (isolated + randomized) | `bun run test:hermetic` | 1818 pass / 0 fail |
| Relative links | script over every living doc | 0 broken |
| `#anchors` | script over 864 headings | 0 broken |
| Doc paths (`src/…`, `scripts/…`, `test/…`, `drizzle/…`) | script over every living doc | 0 broken (three historical audit files name modules without `.ts`, left as written) |
| `bun run <script>` names | compared with `package.json` | all exist |
| Env coverage | names extracted from `src/**`, `scripts/**` vs `.env.example` | complete; only test-internal (`HOME`, `VITEST`, `BUN_TEST`) and the documented CLI overrides (`DB_BACKUP_PATH`, `DB_RESTORE_PATH`) are absent |

Could not verify:

- **Docker build and container smoke**: no Docker daemon here. `Dockerfile`,
  `docker-compose.yml` and `docs/deployment.md` were compared by reading them
  (FFmpeg `n9.0` with the published-digest check, yt-dlp `2026.08.19`, Bun base
  digest `9dba1a1…`).
- **Real provider connections** (WhatsApp QR, Discord gateway, Telegram
  polling): the test harness throws on network access.
- **Telegram acceptance cells**: written from `src/providers/telegram.ts` and
  its tests; no real Telegram account was exercised here.
