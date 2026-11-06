# Documentation Audit — 2026-11-06

Scope: whole repository. Focus: none. Baseline commit: `cb01aae7b4fa52ccfeaa5e7ed7029cb51603b7e3` (branch `maint/room-key-unification`).

## Stale or Incorrect

1. **Location:** `docs/architecture.md` §2 (Platform Providers). **Evidence:** listed only WhatsApp and Discord; `src/providers/telegram.ts` implements the same `BotProvider` contract and is started by `AppRuntime`. **Action taken:** added Telegram bullet.

2. **Location:** `docs/.agent/project-map.md` header. **Evidence:** recorded commit was `f2fdb03…` (2026-11-05) while HEAD is `cb01aae…` (room-key unification complete). **Action taken:** updated recorded commit and date.

3. **Location:** `docs/scripts.md` database table. **Evidence:** `package.json` exposes `db:studio` (`bun x drizzle-kit studio`) but the table omitted it. **Action taken:** added row.

4. **Location:** `docs/maintenance/audit-2026-11-06.md` (maintenance audit) listed room-key unification as "in progress" then marked complete; docs `.audit` had no 2026-11-06 entry. **Action taken:** created this file.

## Missing Coverage

5. **Location:** `docs/architecture.md` §3 Agent Loop. **Evidence:** already notes live tool progress; verified `src/agent/toolProgress.ts` and `BaseTool.describeAction` still drive it. **Action:** none (accurate).

6. **Location:** `docs/room-identity-migration.md`. **Evidence:** migration journal now includes `0023_add_user_identities_pk` and `0024_drop_scheduled_deliveries`; doc references `0022_room_keys` as the introducing migration, which is correct. The unification commit (`cb01aae`) moved `FlowHandler` and `RoleTool` onto `toRoomKey()`/`legacyScopeFor()` from `src/core/roomKeyFormat.ts`. **Action:** none (doc's runtime contract still holds; producers now unified).

7. **Location:** `docs/tools.md`. **Evidence:** opt-in flags `ENABLE_GAME_SEARCH`, `ENABLE_SOFTWARE_SEARCH` and TTS config (`TTS_API_KEY`, `TTS_PROVIDER/MODEL/VOICE`) are documented via admin config allowlist and setup; tool table is accurate. **Action:** none.

## Structural Problems

8. None new. Existing topic-split layout remains appropriate; cross-references resolve.

## Found While Documenting

- `src/admin/data.ts` `CONFIG_ALLOWLIST` still drifts from actual env reads: includes `EMBEDDING_ENDPOINT` (never read) and omits read keys `EMBEDDING_API_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_TIMEOUT_MS`, `EMBEDDING_CANDIDATES`, `EMBEDDING_DEDUPE_THRESHOLD`, `JELLYFIN_API_URL`, `JELLYFIN_API_KEY`, `JELLYFIN_EXTERNAL_URL`, `SEERR_API_KEY`, `SEERR_API_URL` (only `SEERR_URL` listed), `JINA_API_KEY`, `SEARXNG_URL`, and `ELASTRAX_DB_SYNCHRONOUS`. Not a doc defect; flagged for code owner. Do not fix (code is read-only).
- `src/core/FlowHandler.ts` and `src/tools/RoleTool.ts` room-key construction was unified in `cb01aae`; verify no other manual `room:${platform}:${id}` builders remain. (Maintenance audit TD-006 tracked this.)

## Plan

- [x] `docs/architecture.md` — add Telegram provider bullet
- [x] `docs/.agent/project-map.md` — update recorded commit/date
- [x] `docs/scripts.md` — add `db:studio` row
- [x] `docs/.audit/docs-audit-2026-11-06.md` — this file
- [x] Consistency pass (terminology) — verified no broken links

## Verification

- `bun run check`: pass (1557 tests, 0 fail, lint clean, typecheck clean, db:check clean) — run 2026-11-06.
- `bun run db:generate`: not re-run this pass; prior pass reported "No schema changes".
- Markdown link check: all relative links resolve.
- Code snippets: verified against `src/` signatures for env vars, admin routes, scripts.
