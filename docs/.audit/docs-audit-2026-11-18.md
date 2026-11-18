# Documentation audit — 2026-11-18

Scope: whole repo. Focus: none. Branch: `maint/2026-11-18-pass4`.
Prior pass: `docs-audit-2026-11-17.md` (shipped with `6c2e225`).

The parallel maintenance pass landed 26 commits after that documentation pass
(`47aaab9..10fc3b2`), and another maintenance audit
(`docs/maintenance/audit-2026-11-18.md`) is still editing the tree. Every claim
below was read against the code at `10fc3b2`; the one uncommitted file
(`src/providers/whatsapp.ts`) was not used as evidence for any doc statement.

## Baseline (verified before changes)

| Check | Command | Result |
|---|---|---|
| Lint | `bun run lint` | clean at baseline of the parallel pass (recorded in `docs/maintenance/audit-2026-11-18.md`) |
| Typecheck | `bun run typecheck` | clean (same record) |
| Tests | `bun test --no-env-file test/` | 1767 pass / 0 fail (same record) |
| Schema | `bun run db:check` | "Everything's fine" (same record) |

This documentation pass does not change code; its own verification table is at
the end.

## Method

- Extracted every env name read by `src/**` and `scripts/**` (`process.env`,
  `env.X`, `env['X']`, and the `read*Env`/`readInteger` helpers) and diffed it
  against `.env.example`; coverage is complete apart from test-only keys
  (`HOME`, `VITEST`, `BUN_TEST`) and the documented CLI overrides
  (`DB_BACKUP_PATH`, `DB_RESTORE_PATH`).
- Resolved every relative Markdown link and anchor, and every `src/…`,
  `scripts/…`, `test/…`, `drizzle/…` path named in a doc.
- Checked every `bun run <script>` name against `package.json`.
- Re-read the changed modules for each commit in `47aaab9..10fc3b2`.

## 1. Stale or incorrect

| # | Location | Issue | Evidence | Action |
|---|---|---|---|---|
| 1 | `docs/deployment.md` (Supported runtime) | Says the container "verifies an FFmpeg `8.1.3` build with SHA-256 checksums per architecture". The image now takes BtbN's newest release branch (`n9.0` today) from the moving `latest` tag and checks the sha256 GitHub publishes for that asset at build time. | `Dockerfile` (`FFMPEG_BRANCH=n9.0`, `fetch` stage), `20b0a86`, `3616403` | State branch + build-time digest check and the `FFMPEG_BRANCH` build arg |
| 2 | `docs/configuration.md` §11, §13, §10 and `.env.example` (Transcription) | `SEARXNG_URL`, `SEERR_API_URL` and `JELLYFIN_API_URL` are described as "http allowed on loopback". They now opt in to plain http on **any** host (`allowPlainHttp`). `TRANSCRIBE_ENDPOINT` is the opposite: plain http is loopback-only because it carries a credential. | `src/config/env.ts` `validateUrl`; `8499e18` | Correct both directions |
| 3 | `docs/error-handling.md` (Startup validation) | Names the removed option `allowLoopbackHttp`. | `src/config/env.ts` (`allowPlainHttp`) | Rewrite the rule |
| 4 | `docs/services.md` (InboxService row, timer table, delivery section), `docs/architecture.md` §13, `docs/error-handling.md` | Inbox leases are described as a fixed 120 s (`LEASE_MS = 120_000`) and `recoverStranded` as a "24 h lease". The inbox lease is derived at startup from the turn budget and clamped to 10–60 minutes; 24 h is the age threshold for never-claimed rows, not a lease. | `src/messaging/InboxService.ts` `resolveInboxLeaseMs`/`recoverStranded`; `src/runtime/AppRuntime.ts` (`recoverStranded(24 h)`) | Separate the inbox lease, the outbox lease (120 s), and the 24 h recovery age |
| 5 | `docs/architecture.md` §14, `docs/services.md` (DigestService row) | Says failed digests retry "only for `MAX_DIGEST_ATTEMPTS = 3` attempts per day/week". The weekly media rollup now has its own budget of 30 attempts; the daily summary keeps 3. | `src/utils/DigestService.ts` (`MAX_WEEKLY_DIGEST_ATTEMPTS = 30`); `0bc4aff` | Split daily 3 / weekly 30 |
| 6 | `docs/admin-dashboard.md` (Dashboard actions) | `retention-report` is described as "runs retention in dry-run mode and returns counts". It runs nothing: it reports whether `RETENTION_DRY_RUN` is on and points to the CLI. | `src/admin/data.ts` `actionRetentionReport` | Describe what it does |
| 7 | `docs/services.md` (Outbox) | The outbox idempotency key is described as "SHA-256 of the platform and job parts". The chat room is now part of the key, because provider message ids are only unique within a room. | `src/agent/index.ts` `outboxKeyParts`; `a336225` | Add the room to the key description |
| 8 | `docs/tools.md` (Memory row), `docs/architecture.md` §8 | "The LLM automatically curates this based on user interactions." Storage now requires prior consent (`consent` action or a stored grant), group scope requires `admin`, facts are stored inert (`[INERT_DATA]`), and there are entry/byte quotas plus semantic dedupe. | `src/tools/MemoryTool.ts` | Describe the consent/scope model and link the tool row to it |
| 9 | `docs/tools.md` (Knowledge, Memory rows) | `/kb remove` is described only as removing attached/quoted documents; it also takes `<document_id>` (and an omitted id clears the room). The Memory aliases `mem`, `remember`, `forget` are not listed. | `src/tools/KnowledgeTool.ts` (`document_id`), `src/tools/MemoryTool.ts` (`aliases`); `294d3b8` | Update both rows |
| 10 | `docs/services.md` (Reminder delivery) | Does not say that `every <n> days` (integer) and `daily`/`weekly` are calendar cadences that keep local wall-clock time across DST; only `hourly` and fractional-day intervals are fixed milliseconds. | `src/utils/Scheduler.ts` `computeNextOccurrence`/`advanceCalendarDays`; `102c6cb` | Add the cadence rule |
| 11 | `docs/api.md` (Delivery responses) | Lists `200` and `207` only. A delivery where every destination failed returns `502`; a request with no destinations/subscribers returns `200 {"delivered":0}` with a `note`. | `src/webhooks/WebhookServer.ts` (`handleGenericWebhook`) | Document both |
| 12 | `docs/api.md` (Replay and rate limits) | Says "Source and connection keys are independently governed". The peer/connection key is deliberately omitted when the peer is loopback, because behind the documented proxy it is always `127.0.0.1`. | `src/webhooks/utils.ts` `webhookRateLimitKeys`; `494699f` | State the loopback exception |
| 13 | `docs/provider-staging-matrix.md` DC-8 | "never over 2 000 characters" — Discord chunking now measures UTF-16 code units. | `src/utils/textChunking.ts` `chunkTextDiscord`; `3d0a40c` | Say UTF-16 units |
| 14 | `docs/setup.md` (Optional integrations) | Lists transcription without the URL rule: `TRANSCRIBE_ENDPOINT` must be https unless loopback. | `src/config/env.ts` | Add the constraint |
| 15 | `docs/configuration.md` §25 | Says the 8-task running cap is "built into `AppRuntime`". It is `MessageQueue`'s `maxRunning` default; `AppRuntime` passes no override. It also omits that `MESSAGE_QUEUE_GLOBAL_LIMIT` is raised to at least the per-room limit (with a warning) when configured lower. | `src/utils/MessageQueue.ts` (`maxRunning ?? 8`), `AppRuntime` constructor; `2b72519` | Attribute the default correctly and note the raise |
| 16 | `docs/configuration.md` (How defaults are enforced) | "Weak secrets (< 24 bytes)" reads as applying to every secret, but `METRICS_AUTH_TOKEN` is deliberately not length-checked at startup (a short one disables its surfaces). | `src/config/env.ts` (comment at the removed `validateSecret` call); `2d5ec8c` | Name the secrets that hard-fail |
| 17 | `docs/configuration.md` §15 | `SCHEDULED_TASKS_ALLOWED_ROOMS` accepts either the canonical room key or the raw remote room id. | `src/utils/scheduledTasks.ts` (`consumeTaskBudget`) | Say both forms |

## 2. Missing coverage

| # | Location | Gap | Action |
|---|---|---|---|
| 18 | `docs/architecture.md` | No description of the process entry point. `src/index.ts` validates env, ensures the schema, initialises `FlowHandler`, boots `AppRuntime`, and only then installs signal/fatal handlers; shutdown closes the DB and force-exits after cancelling tracked child processes. | New "Process lifecycle" section |
| 19 | `docs/services.md` (AppRuntime sequence) | The start sequence omits the pre-provider `parseWebhookConfig` call that makes a bad `WEBHOOK_*` value fail before any provider connects. | Add the step |
| 20 | `docs/architecture.md` §9 | Telegram subscribes to `message_reaction` explicitly (it is not in the Bot API's default `allowed_updates`), which is what makes reaction feedback work there. | One sentence |
| 21 | `docs/tools.md` (Execution model) | `field=value` overrides are now honoured by every tool, not only tools with a command grammar; only declared properties are treated as overrides. | One sentence |
| 22 | `docs/flows.md` | Nothing describes what happens when a flow processor throws: the session is kept for two retries and released on the third consecutive failure. | One bullet |

## 3. Structural problems

None. Configuration stays in `docs/configuration.md`/`.env.example`, routes in
`docs/api.md`/`docs/admin-dashboard.md`, timers and delivery semantics in
`docs/services.md`, and the bootstrap lifecycle now has a home in
`docs/architecture.md`. No file moved.

## 4. Found while documenting (code observations, not fixed)

- `src/admin/data.ts` `CONFIG_ALLOWLIST` still lists `EMBEDDING_ENDPOINT`,
  which no code reads (`EmbeddingService` reads `EMBEDDING_API_URL`), so the
  dashboard always shows it as `(unset)`. Carried over from earlier passes.
- `src/utils/Scheduler.ts` still has a comment claiming the no-sender deferral
  path "is retired after `MAX_DELIVERY_ATTEMPTS`"; the code uses
  `MAX_DEFER_ATTEMPTS = 24` and never retires a recurring reminder. Code comment
  only.
- `src/providers/whatsapp.ts` is modified but uncommitted in this checkout
  (status/newsletter filtering). No documentation claim depends on it; the
  parallel maintenance pass owns it.
- `.env.example` ships `SEARXNG_URL` as an active placeholder so copying it
  verbatim needs an edit; that remains the documented "set at minimum" path.
- Docker/compose behaviour was verified by reading `Dockerfile` and
  `docker-compose.yml`; no Docker daemon is available in this environment, so no
  build or container smoke was run.

## Plan

1. `docs/.audit/docs-audit-2026-11-18.md` — created (this audit).
2. `docs/architecture.md` — process lifecycle, memory consent, inbox lease, digest budgets, Telegram reactions, feedback cap wording.
3. `docs/services.md` — inbox lease, start sequence, outbox key, digest budgets, reminder cadence.
4. `docs/error-handling.md` — plain-http rules, lease wording, 502.
5. `docs/configuration.md` — plain-http rules, queue default, scheduled-room forms, secret enforcement.
6. `docs/api.md` — delivery statuses, rate-limit keys, readiness registration.
7. `docs/database.md` — self-healing fingerprint check.
8. `docs/deployment.md` — FFmpeg branch/digest.
9. `docs/setup.md` — transcription URL rule.
10. `docs/tools.md` — memory consent/scopes, knowledge remove by id, `field=value`.
11. `docs/admin-dashboard.md` — retention-report behaviour.
12. `docs/provider-staging-matrix.md` — UTF-16 unit.
13. `docs/flows.md` — repeatedly failing flow step.
14. `.env.example` — transcription URL rule.
15. `docs/.agent/project-map.md` — recorded commit.

Progress:

- [x] Audit written
- [x] `docs/architecture.md`
- [x] `docs/services.md`
- [x] `docs/error-handling.md`
- [x] `docs/configuration.md`
- [x] `docs/api.md`
- [x] `docs/database.md`
- [x] `docs/deployment.md`
- [x] `docs/setup.md`
- [x] `docs/tools.md`
- [x] `docs/admin-dashboard.md`
- [x] `docs/provider-staging-matrix.md`
- [x] `docs/flows.md`
- [x] `.env.example`
- [x] `docs/.agent/project-map.md`
- [x] Validation re-run

## Verification (after changes)

| Check | Result |
|---|---|
| Full gate `bun run check` | pass: lint clean, typecheck clean, **1779 pass / 0 fail**, 135 files, 5496 `expect()` calls, `db:check` "Everything's fine" |
| Relative links and `#anchors` | all resolve |
| Doc paths (`src/…`, `scripts/…`, `test/…`, `drizzle/…`) | all resolve |
| `bun run <script>` names | all exist in `package.json` |
| Env coverage | every name read by `src/**`/`scripts/**` is in `.env.example`; only test-internal keys (`HOME`, `VITEST`, `BUN_TEST`) and the documented `DB_BACKUP_PATH`/`DB_RESTORE_PATH` CLI overrides are absent |

The changed paragraphs were re-read against `InboxService.ts`, `OutboxService.ts`,
`DigestService.ts`, `Scheduler.ts`, `MemoryTool.ts`, `KnowledgeTool.ts`,
`WebhookServer.ts`, `webhooks/utils.ts`, `db/index.ts`, `config/env.ts`,
`utils/MessageQueue.ts`, `admin/data.ts`, `Dockerfile` and `docker-compose.yml`
after the edits.

Could not verify:

- Docker build and container smoke: no Docker daemon in this environment. The
  `Dockerfile`/Compose claims were checked by reading both files.
- Real provider connections (WhatsApp QR, Discord gateway, Telegram polling):
  the test harness throws on network access.
- Stability under the parallel pass: `src/providers/whatsapp.ts`,
  `discord.ts`, `telegram.ts` and `test/telegram.test.ts` were being edited by
  the maintenance pass while this documentation pass ran. No doc statement here
  depends on that uncommitted work; the gate above passed against the tree at
  the time it ran.

