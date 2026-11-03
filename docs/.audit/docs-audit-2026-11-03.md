# Documentation Audit — 2026-11-03

Scope: whole repository. Focus: none.

## Stale or Incorrect

1. **Location:** `docs/room-identity-migration.md` §Rollback. **Evidence:** referred to "v8.1 migration/database" while release/package version is 8.0.1 (`package.json` `"version": "8.0.1"`) and `docs/architecture.md` §5 says "ElastraX v8.0.1 (migration `0022_room_keys`)". **Action taken:** changed "v8.1" to "v8.0.1" in rollback lines.

2. **Location:** `docs/api.md` route table. **Evidence:** omitted `/admin/app.js` and `/admin/style.css`, which `src/admin/routes.ts` serves as static assets (`asset('text/javascript; …', APP_JS)` / `asset('text/css; …', STYLE_CSS)`). **Action taken:** added two rows.

3. **Location:** `.env.example` opt-in flags. **Evidence:** lists `ENABLE_PIRACY_TOOLS` / `ENABLE_PIRACY_SEARCH` with an explicit "not consumed by the code" note; only `ENABLE_GAME_SEARCH` / `ENABLE_SOFTWARE_SEARCH` are consumed (`GameSearchTool`/`SoftwareSearchTool`). **Status:** already annotated; no code reads the piracy flags. Recorded.

4. **Location:** `docs/.agent/project-map.md`. **Evidence:** recorded commit `9fc0131…` (2026-10-31) while HEAD had advanced through the 2026-11-03 maintenance passes. **Action taken:** updated recorded commit to `78258c5…` and date to 2026-11-03.

## Missing Coverage

5. **Location:** `docs/tools.md` Knowledge row. **Evidence:** `src/utils/ocr.ts` transcribes images and scanned PDFs with a vision model when `KB_OCR_ENABLED` (default on); `.env.example` documents `KB_OCR_*`. Tools doc did not mention OCR. **Action taken:** added OCR note to the Knowledge row.

6. **Location:** `docs/architecture.md`. **Evidence:** reaction feedback (`src/utils/feedback.ts`) is exported on `/metrics` and appended to a JSONL log, but no architecture section mentioned it. **Action taken:** added §15 Reaction Feedback.

7. **Location:** `README.md` quick start. **Evidence:** mentioned WhatsApp and Discord but omitted Telegram setup (`TELEGRAM_BOT_TOKEN`, `BOT_OWNER_TELEGRAM_ID`), which `src/providers/telegram.ts` supports and `docs/setup.md` §3 documents. **Action taken:** added Telegram line.

## Structural Problems

8. None identified beyond those already recorded in the 2026-11-02 audit (testing knowledge lives in `docs/setup.md` §Testing; no separate testing file).

## Found While Documenting

- `src/admin/data.ts` `CONFIG_ALLOWLIST` still drifts from actual env reads: includes `EMBEDDING_ENDPOINT` (not read anywhere; actual is `EMBEDDING_API_URL`), omits read keys such as `JELLYFIN_API_URL`/`JELLYFIN_API_KEY`/`JELLYFIN_EXTERNAL_URL`, `SEERR_API_KEY`, `EMBEDDING_API_URL`/`EMBEDDING_API_KEY`/`EMBEDDING_TIMEOUT_MS`, `AI_MAX_TOKENS_PARAM` and per-provider `AI_<NAME>_*` capability flags, `AI_SUPPORTS_IMAGE`/`AI_SUPPORTS_TOOLS`/`AI_STREAM_USAGE`/`AI_SUPPORTS_PARALLEL_TOOLS`. Admin dashboard config view therefore under-reports. Code change required; not applied (code is read-only during docs work).
- `src/config/env.ts` `validateEnv` does not validate `WEBHOOK_BODY_READ_TIMEOUT_MS`, `WEBHOOK_ENQUEUE_TIMEOUT_MS`, `WEBHOOK_READINESS_TIMEOUT_MS`, `WEBHOOK_MAX_*` (they use `readInteger` defaults in `src/webhooks/config.ts`). Validation gap, not a startup failure; recorded in 2026-11-02 audit and still present.
- Deferred code items from the 2026-11-03 maintenance audit remain open and are not documentation: `AuthService.setRole` check-then-insert race (test fixture unique index differs from production), process-global `Scheduler`/`DigestService` singletons clobbering across runtimes in tests, `FlowHandler` session-cleanup timer not cleared on `stop()`, webhook query-string secret compatibility (`WEBHOOK_QUERY_SECRET_COMPAT_ENABLED`) opt-in risk. Recorded for owner decision.
- `src/tools/WebScrapeTool.ts` gained SSRF validation and URL redaction in the 2026-11-03 pass 2 (`validateSsrfUrl`, `redactUrl`); other URL-accepting tools (e.g. `DownloadTool`) already validated. Docs `tools.md` does not describe SSRF policy; consider a one-line note if operators need it.

## Plan

Files updated:
- `docs/room-identity-migration.md` — version label fix.
- `docs/api.md` — static asset rows.
- `docs/tools.md` — Knowledge OCR note.
- `docs/architecture.md` — §15 Reaction Feedback.
- `README.md` — Telegram quick-start line.
- `docs/.agent/project-map.md` — recorded commit/date.
- `docs/.audit/docs-audit-2026-11-03.md` — this file.

Progress checklist:
- [x] Fix room-identity "v8.1" -> "v8.0.1"
- [x] Add admin static asset routes to api.md
- [x] Add Knowledge OCR note to tools.md
- [x] Add Reaction Feedback section to architecture.md
- [x] Add Telegram line to README.md
- [x] Update project-map recorded commit
- [x] Run verification commands
- [x] Consistency pass

## Verification

Commands run (all passed):
- `bun run lint` — clean (`--max-warnings=0`).
- `bun run typecheck` — clean.
- `bun run db:check` — "Everything's fine".
- `bun run db:generate` — "No schema changes, nothing to migrate" (drift gate clean).
- `bun test --no-env-file test/` — 1532 pass, 0 fail, 125 files.
- Could not run `bun run test:hermetic`/`test:random` separately; normal run already covers the suite and these are the same flags reordered. Flagged as not separately verified.
- Snippet/signature check: no code snippets with signatures were added; paths referenced (`src/admin/routes.ts`, `src/utils/ocr.ts`, `src/utils/feedback.ts`, `src/providers/telegram.ts`) verified to exist.

## Flagged for your decision

- Whether to reconcile `CONFIG_ALLOWLIST` in `src/admin/data.ts` with actual env reads (code change; out of scope for docs-only work).
- Whether to add env validation for `WEBHOOK_*` timeout/bound knobs in `src/config/env.ts`.
