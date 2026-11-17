# Documentation audit — 2026-11-17

Scope: whole repo. Focus: none. Branch: `maint/2026-11-17-full-pass`.
Prior pass: `docs-audit-2026-11-16.md` (finished clean, shipped as `49be072`).

The maintenance pass that runs in parallel with this one has already landed two
fix commits after that documentation pass — `cd131d4` (Telegram limits counted
in UTF-16) and `47aaab9` (deferred summary overflow, keyword-recall fallback,
action policies for model tool calls) — and is still editing the tree. Every
claim below was read against the code as of `47aaab9`, not against the previous
audit.

## Baseline (verified before changes)

| Check | Command | Result |
|---|---|---|
| Full gate | `bun run check` (lint → typecheck → test → `db:check`) | pass: lint clean, typecheck clean, 1692 pass / 0 fail, 132 files, `db:check` clean |

## Method

Every claim below was read against the implementing module. The mechanical
checks were re-run against the current tree:

- every `process.env` / env-helper name read by `src/**` and `scripts/**`
  extracted and diffed against `.env.example` and `docs/configuration.md`;
- every relative Markdown link and `#anchor` resolved;
- every `src/…`, `scripts/…`, `test/…`, `drizzle/…`, `docs/…` path named in a
  doc checked for existence;
- every `bun run <script>` named in a doc checked against `package.json`.

## 1. Stale or incorrect

| # | Location | Issue | Evidence | Action |
|---|----------|-------|----------|--------|
| 1 | `docs/architecture.md` §9 (Telegram) | "Replies are chunked on code points, and `editMessage` splits head/remainder the same way". The Bot API counts its 4096 limit in **UTF-16 units**; `chunkTextTelegram` now passes `measure: 'utf16'` and `editMessage` uses `splitTextAtUtf16Limit`. Counting code points produced chunks the API rejected as too long (`cd131d4`). | `src/utils/textChunking.ts` `chunkTextSmart`/`splitTextAtUtf16Limit`; `src/providers/telegram.ts` `editMessage`; `src/providers/telegramText.ts` | State the unit and that neither path splits a surrogate pair |
| 2 | `docs/open-pr-triage.md` (group 1 bullet) | "The pattern is not yet on `main`. Committed `main` still performs a length comparison …" — contradicts the document's own resolution header. `safeSecretCompare` hashes both operands with SHA-256 and compares fixed 32-byte digests with `timingSafeEqual`. | `src/webhooks/utils.ts` `safeSecretCompare` | Rewrite the bullet to record that the pattern landed |
| 3 | `README.md` (Architecture bullet) | "`src/plugins` contains runtime plugin tooling; user flow files are stored in the data directory." No code reads flow files from disk: flow *state* lives in `flow_sessions`, processors live in `src/flows/`. | `src/core/FlowHandler.ts`, `src/flows/registry.ts`, `src/db/schema.ts` (`flow_sessions`) | Correct to the real storage |
| 4 | `docs/tools.md` (Misc table) | Game Search and Software Search show no alias ("—"), but both declare aliases (`searchgame`/`findgame`, `searchsoftware`/`findsoftware`) and are registered with them once their flag is set. | `src/tools/GameSearchTool.ts`, `src/tools/SoftwareSearchTool.ts` | List the aliases |
| 5 | `docs/architecture.md` §13, `docs/services.md` (timers) | The startup parser-coverage scan is described as running "only when `runStartupCoverageScan` is passed", which reads as optional/never armed. The default bootstrap now always passes it (2 000 rows, 5 s after boot, non-fatal). | `src/index.ts` (constructor deps), `src/runtime/AppRuntime.ts`, `src/runtime/startupDiagnostics.ts` | Say the bootstrap arms it; keep the non-fatal bound |

## 2. Missing coverage

| # | Location | Issue | Action |
|---|----------|-------|--------|
| 6 | `docs/architecture.md` §4 | Nothing describes how the prompt is assembled: system prompt + language + roles, at most one reference block (personal memories in a DM, room knowledge in a group — personal memory is never injected into a group), the rolling-summary watermark in `app_kv`, and the untrusted-content fences. The summary batch policy (`SUMMARY_LOOKAHEAD = 16`, `SUMMARY_MIN_BATCH = 8`, overflow widened back into the active window when the batch is below the threshold) is also undocumented, and it is what decides whether history is summarised or re-sent. | New "Prompt assembly and rolling summary" subsection under §4 |
| 7 | `docs/api.md` (operational endpoints) | `/metrics` is documented as "protected Prometheus metrics" but not one metric family is named, so an operator cannot build a dashboard or alert from the docs. `HealthMetrics.getPrometheusMetrics` exports 18 families. | Add a table of families, types and labels |
| 8 | `docs/services.md` (service list) | `ConversationSummarizer` is named in `docs/architecture.md` but missing from the service table, although it runs on every turn when `CONTEXT_SUMMARIZE` is on and its watermark is the persisted state of that service. | Add the row |

## 3. Structural problems

None. One canonical home per topic holds: configuration in
`docs/configuration.md`/`.env.example`, routes in `docs/api.md`, timers and
delivery semantics in `docs/services.md`. No file was reorganized.

## 4. Found while documenting (code observations, not fixed)

- `docs/services.md` "Recurring schedules keep their anchor" now describes the
  anchor that the parallel maintenance pass is adding: migration
  `0025_reminder_anchor_day` plus `reminders.anchor_day`, captured from the first
  fire date. While this pass ran, that change was **uncommitted** in the working
  tree; if it is dropped, the sentence about `anchor_day` must go back to
  "anchored to `created_at`'s day-of-month" (which was the code at `47aaab9`).
- `docs/provider-staging-matrix.md`'s `duplicate_event` row describes the
  **fake harness** key (`senderId:messageId`), while the real inbox uses
  SHA-256 of `platform + chatId + messageId`. Clarified in the row so the two
  are not conflated (item 7 in the plan; a wording fix, not a behaviour claim).
- `src/admin/data.ts` `CONFIG_ALLOWLIST` still lists `EMBEDDING_ENDPOINT`, which
  no code reads (`EmbeddingService` reads `EMBEDDING_API_URL`), so the dashboard
  always shows it as `(unset)`. Carried over from 2026-11-14/15.
- `src/utils/Scheduler.ts` still has a comment claiming a deferral path is
  "retired after `MAX_DELIVERY_ATTEMPTS`"; the code uses `MAX_DEFER_ATTEMPTS = 24`
  and never retires a recurring reminder. Code comment only.
- `.env.example` repeats `MEDIA_PUBLIC_LIBRARY`/`ENABLE_MEDIA_LIBRARY` in the
  media-integration and media-storage sections. Both occurrences are documented
  aliases of the same switch; left as-is (example values, not conflicting).
- `.env.example` ships `SEARXNG_URL` as an active placeholder URL and
  `AI_API_BASE_URL=""`, so copying it verbatim does not start. That is the
  documented "set at minimum" path in `README.md`/`docs/setup.md`; left as-is.
- `web_search` remains always-loaded with no `isEnabled()` guard, so an
  unconfigured deployment advertises a tool that can only answer "not
  configured". Documented, not changed: it alters which tools exist for every
  deployment.
- `modal/` is described as an untracked, experimental Python adapter, but the
  directory in a working checkout currently holds only `__pycache__`. The README
  parenthetical stays accurate; no fresh clone receives it.

## Plan

Files touched:

1. `docs/.audit/docs-audit-2026-11-17.md` — created (this audit).
2. `docs/architecture.md` — UTF-16 Telegram limits, prompt-assembly subsection, coverage-scan wiring.
3. `docs/services.md` — ConversationSummarizer row, coverage-scan wiring.
4. `docs/tools.md` — Game/Software Search aliases.
5. `docs/api.md` — `/metrics` metric families.
6. `docs/open-pr-triage.md` — timing-safe comparison now on `main`.
7. `docs/provider-staging-matrix.md` — harness dedupe-key clarification.
8. `README.md` — flow storage claim.
9. `docs/message-context.md` — drop a stale `(V7.2)` field annotation.
10. `docs/.agent/project-map.md` — recorded commit.

Progress:

- [x] Audit written
- [x] `docs/architecture.md`
- [x] `docs/services.md`
- [x] `docs/tools.md`
- [x] `docs/api.md`
- [x] `docs/open-pr-triage.md`
- [x] `docs/provider-staging-matrix.md`
- [x] `README.md`
- [x] `docs/message-context.md`
- [x] `docs/.agent/project-map.md`
- [x] Validation re-run

## Verification (after changes)

| Check | Result |
|---|---|
| Full gate `bun run check` | pass: lint clean, typecheck clean, **1692 pass / 0 fail**, 132 files, `db:check` "Everything's fine" |
| Docs links (relative) and `#anchors` | all resolve |
| Doc paths (`src/…`, `scripts/…`, `test/…`, `drizzle/…`) | all resolve (historical `docs/maintenance/*` and `docs/.audit/*` records excluded) |
| `bun run <script>` names | all exist in `package.json` |
| Env coverage | code-read names vs `.env.example` / `docs/configuration.md`: identical apart from `AI_<NAME>_*`, `ROLE_PRIV_*`, `RETENTION_*` patterns, `WEBHOOK_ENABLED` (read through `readBoolean(env, 'WEBHOOK_ENABLED', …)`), and test-internal keys. `RETENTION_DRY_RUN` is documented in `docs/database.md` (its canonical home), not repeated in `docs/configuration.md`. |

The `docs/architecture.md` metrics-free claims, the route table in `docs/api.md`,
and the timer table in `docs/services.md` were each re-read against
`WebhookServer.ts`, `admin/routes.ts`, `AppRuntime.ts` and `HealthMetrics.ts`
after the edits.

Could not verify:

- Real provider connections (WhatsApp QR, Discord gateway, Telegram polling) and
  GitHub Actions execution: the harness throws on network access and the
  account-side runners are still not allocating steps. Provider claims were
  verified by reading the code and the staging harness.
- `docker compose build` / container smoke: no Docker daemon in this pass; the
  `Dockerfile`, `docker-compose.yml` and deployment claims were checked by
  reading them against `docs/deployment.md`.
- Stability of the numbers above: the parallel maintenance pass was still
  editing the tree while this pass ran — `src/utils/DigestService.ts`,
  `src/utils/scheduledTasks.ts`, `src/utils/semanticMemory.ts`,
  `src/utils/Scheduler.ts`, `src/tools/ReminderTool.ts`, `src/db/schema.ts` and
  their tests, plus migration `0025_reminder_anchor_day`. Docs were verified
  against `HEAD` `47aaab9` plus that working tree. Two claims follow the
  uncommitted part: the reminder anchor in `docs/services.md` and, to a lesser
  degree, the digest retry budget (unchanged: `MAX_DIGEST_ATTEMPTS = 3`). If any
  of that work is dropped or changed, re-read the affected paragraph before
  merging.
