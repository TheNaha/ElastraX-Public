# Documentation audit — 2026-11-16

Scope: whole repo. Focus: none. Branch: `maint/2026-11-16-full-pass`.
Prior pass: `docs-audit-2026-11-15.md` (finished clean, shipped as `dac003f`).

The 2026-11-16 maintenance pass changed behaviour after that documentation pass
(`82bc60b`…`98a1ed5`: streaming preview cap, rate-limit ordering, outbox
conflict semantics, digest retry budget and marker pruning, schema-index
contract, backup pruning, transaction guard, schema-catalog cache, provider
lifecycle fixes, registry admission, FFmpeg option validation). This pass
re-read the docs against that code.

## Baseline (verified before changes)

| Check | Command | Result |
|---|---|---|
| Full gate | `bun run check` (lint → typecheck → test → `db:check`) | pass: lint clean, typecheck clean, **1680 pass / 0 fail**, 132 files, `db:check` clean |

## Method

Every claim below was read against the implementing module, not against the
previous audit. Environment variables read by code were extracted mechanically
and diffed against `.env.example` and `docs/configuration.md`; relative links,
named paths and `bun run` script names in docs were checked by script.

## 1. Stale or incorrect

| # | Location | Issue | Evidence | Action |
|---|----------|-------|----------|--------|
| 1 | `docs/architecture.md` opening paragraph | Says the design decouples "the messaging platforms (WhatsApp, Discord)". Telegram is a first-class provider. | `src/providers/telegram.ts`; §9 of the same doc | Add Telegram |
| 2 | `docs/architecture.md` §10 (Durable Delivery) | Inbound events are described as deduplicated by `senderId:messageId`. The inbox key is a SHA-256 of `platform`, `chatId` and `messageId`, with a random key when the provider supplied no usable id. | `InboxService.eventKeyFor` | Correct the key |
| 3 | `docs/architecture.md` §4, `docs/services.md` (Outbox) | The streaming preview is described as "frozen at 1800 characters". It is clamped in **UTF-16 units** — the unit the providers count — and never splits a surrogate pair. | `src/agent/index.ts` `STREAM_PREVIEW_LIMIT` / `clampStreamPreview` | State the unit |
| 4 | `docs/services.md` (Inbox / Outbox delivery guarantees) | Says the direct send is "bounded to `DIRECT_SEND_TIMEOUT_MS` (inside the grace)" and that enqueue "inserts a row". The bound is `DIRECT_SEND_GRACE_MS − 2 × CLOCK_SKEW_BUFFER_MS` = 10 000 ms, and a same-key re-enqueue now updates a `pending`/`failed` row (`ON CONFLICT … DO UPDATE`) instead of being ignored. | `src/agent/index.ts` `DIRECT_SEND_TIMEOUT_MS`; `OutboxService.enqueueText`, `recordTextDelivered` | Give the real bound and the conflict semantics |
| 5 | `docs/configuration.md` §11, `.env.example` (SearXNG) | "Unset disables web search" implies the tool disappears. `web_search` is always loaded and always registered; without `SEARXNG_URL` every call answers that search is not configured (OI-11). | `src/tools/WebSearchTool.ts` has no `isEnabled()` guard; `src/tools/registry.ts` admission | Say what unset actually does |
| 6 | `docs/database.md` (Backups and restore) | Describes only `VACUUM INTO` plus `BACKUP_KEEP`. Pruning now refuses a manifest whose `snapshot.file` is not a bare filename and sweeps snapshot files with no manifest after a 1 h grace. | `src/db/backup.ts` `pruneBackups`, `ORPHAN_GRACE_MS` | Document both |
| 7 | `docs/.agent/project-map.md` header | Recorded commit `a77f4c7`; the review follow-ups (`98a1ed5`) changed `src/agent`, `src/agent/toolProgress.ts`, `src/messaging/OutboxService.ts` after it. | `git log` | Update commit/date |
| 8 | `docs/provider-staging-matrix.md` (Sign-off) | Malformed link `[canary-runbook.md)` — it renders as literal text and does not resolve. | link scan | Fix the link |
| 9 | `docs/architecture.md` §4 | The agent pipeline is listed as flow → commands → intent → LLM, but the code decides intent first, then lets an active flow consume the message, then rate-limits, then routes slash commands. The tool-progress icons are also listed as ✅/❌ only (⏳ is the running icon). | `src/agent/index.ts` `handleMessageInternal` order; `src/agent/toolProgress.ts` | Reorder the pipeline and add ⏳ |

## 2. Missing coverage

| # | Location | Issue | Action |
|---|----------|-------|--------|
| 9 | `docs/architecture.md` §14, `docs/services.md`, `.env.example` (Digests) | The digest retry budget is undocumented: a failed digest releases its marker and is retried by the 60 s poll only `MAX_DIGEST_ATTEMPTS = 3` times, after which the marker is kept until the next day/week. Markers older than 30 days are pruned during the daily pass. | Document the cap and the pruning |
| 10 | `docs/services.md` (Outbox) | A same-key re-enqueue refreshes the payload/`available_at` and resets `attempt_count`/`last_error` while the row is `pending`/`failed`; `recordTextDelivered` promotes an existing non-`sent` row to `sent` so a streamed reply cannot be re-delivered. | Add to the Outbox paragraph |
| 11 | `docs/plugins.md` (Plugin loading) | The loader now rejects a plugin tool whose **name** or any alias collides with an already-admitted tool or alias (`registrationConflict`), not only duplicate aliases among candidates. A plugin named after a built-in alias used to capture that command. | Add the admission step |
| 12 | `docs/tools.md` (Execution model) | The live progress message is bounded to 1 800 UTF-16 units so it cannot grow past the platform limit and duplicate its tail on every edit. | One sentence |
| 13 | `docs/tools.md` (Media tools) | `convert_media` accepts optional `resolution` (`720p` / `640x480`), `fps`, `quality` (CRF for video, bitrate for audio) and `preset`; these were documented nowhere and previously failed validation. Alias `/cv` is missing from the table. | Document the parameters and alias |
| 14 | `docs/architecture.md` §9 | If the user deletes the message a reply targets, Telegram answers 400; chunk 0 is re-sent without `reply_parameters` instead of losing the answer. | Add to the Telegram section |
| 15 | `docs/error-handling.md` | `withImmediateTransaction` (`src/db/runtime.ts`) is synchronous: a callback returning a promise is rolled back, its rejection is observed and swallowed, and a `TypeError` is thrown. | Add a short subsection |
| 16 | `docs/api.md`, `docs/admin-dashboard.md` | `GET /admin/api/session` (returns the CSRF token for an existing session) is missing from both route tables. | Add the row |
| 17 | `docs/database.md` (Startup migration) | `afterMigrationCallbacks` is described as invalidating "schema-aware caches"; the only registered callback is now the room-key schema catalog, which memoises `sqlite_master`/`pragma_table_xinfo` probes per handle. | Name the cache |

## 3. Structural problems

None. One canonical home per topic still holds. The only structural defect was
the malformed link in `docs/provider-staging-matrix.md` (item 8).

## 4. Found while documenting (code observations, not fixed)

- `src/admin/data.ts` `CONFIG_ALLOWLIST` still lists `EMBEDDING_ENDPOINT`, which no
  code reads (`EmbeddingService` reads `EMBEDDING_API_URL`). The dashboard therefore
  always shows that key as `(unset)`. Carried over from 2026-11-14/15.
- `src/tools/registry.ts` `COMMAND_POLICIES` still carries `language`, `config`
  and `owner_admin.leave` rows that the LLM tool-call path never consults (IG-14).
  Behaviour is documented as a slash-path policy, so the docs describe the real
  enforcement and not the table.
- `src/utils/Scheduler.ts` still has the comment claiming a deferral path is
  "retired after `MAX_DELIVERY_ATTEMPTS`"; the code uses `MAX_DEFER_ATTEMPTS = 24`
  and never retires a recurring reminder. Code comment only.
- `.env.example` repeats `MEDIA_PUBLIC_LIBRARY`/`ENABLE_MEDIA_LIBRARY` in both the
  media-integration and media-storage sections. Both occurrences are documented
  aliases of the same switch; left as-is (example values, not conflicting).
- `.env.example` sets `SEARXNG_URL` to the live placeholder
  `https://your-searxng-instance.example.com` (not commented out), so copying the
  file as-is leaves `web_search` configured against a host that does not exist.
  Left unchanged because it is an example value, but the docs now say what an
  unset value does.
- `web_search` remains `alwaysLoad` with no `isEnabled()` (OI-11), so an
  unconfigured deployment still advertises a tool that can only answer "not
  configured". Documented, not changed: it alters which tools exist for every
  deployment.
- No behavioural bug, dead endpoint or contract change was found in this pass.

## Plan

Files touched:

1. `docs/.audit/docs-audit-2026-11-16.md` — created (this audit).
2. `docs/architecture.md` — platforms, inbox key, preview unit, Telegram reply-target fallback, digest retry budget.
3. `docs/services.md` — outbox conflict semantics and send bound, digest attempt cap.
4. `docs/plugins.md` — name/alias collision admission.
5. `docs/tools.md` — progress bound, `convert_media` parameters and `/cv`.
6. `docs/database.md` — schema-catalog cache, backup pruning/sweep, index contract.
7. `docs/error-handling.md` — synchronous transaction guard.
8. `docs/api.md`, `docs/admin-dashboard.md` — `GET /admin/api/session`.
9. `docs/configuration.md` — `SEARXNG_URL` unset behaviour.
10. `docs/provider-staging-matrix.md` — broken link.
11. `.env.example` — digest retry cap note, SearXNG note.
12. `docs/.agent/project-map.md` — recorded commit, collision check.

Progress:

- [x] Audit written
- [x] `docs/architecture.md`
- [x] `docs/services.md`
- [x] `docs/plugins.md`
- [x] `docs/tools.md`
- [x] `docs/database.md`
- [x] `docs/error-handling.md`
- [x] `docs/api.md`, `docs/admin-dashboard.md`
- [x] `docs/configuration.md`, `.env.example`
- [x] `docs/provider-staging-matrix.md`
- [x] `docs/.agent/project-map.md`
- [x] Validation re-run

## Verification (after changes)

| Check | Result |
|---|---|
| Full gate `bun run check` | pass: lint clean, typecheck clean, 1680 pass / 0 fail, `db:check` clean |
| Docs links (relative) | all resolve |
| Doc paths (`src/…`, `scripts/…`, `test/…`, `drizzle/…`) | all resolve (historical `docs/maintenance/*` records excluded) |
| `bun run <script>` names | all exist in `package.json` or are real files |
| Env coverage | code-read names vs `.env.example` / `docs/configuration.md`: identical, apart from `AI_<NAME>_*`, `ROLE_PRIV_*`, `RETENTION_*` patterns and the test-internal keys |

Could not verify:

- Real provider connections (WhatsApp QR, Discord gateway, Telegram polling) and
  GitHub Actions execution: the harness throws on network access and runners are
  still not allocated. Provider claims were verified by reading the code and the
  staging harness.
- `docker compose build` / container smoke: no Docker daemon in this pass; the
  `Dockerfile`, `docker-compose.yml` and deployment claims were checked by reading
  them against `docs/deployment.md`.
