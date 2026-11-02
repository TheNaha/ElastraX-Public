# Documentation Audit — 2026-11-02

Scope: whole repository. Focus: none.

## Stale or Incorrect

1. **Location:** `docs/architecture.md` §5 (Canonical Room Identity). **Evidence:** says "The v8.1 migration stores a canonical `room:<platform>:<remoteRoomId>` key"; release/package version is 8.0.1 and `docs/room-identity-migration.md` says "ElastraX `v8.0.1` introduces…" **Proposed action:** change "v8.1 migration" to "v8.0.1 (migration `0022_room_keys`)".

2. **Location:** `.env.example` opt-in flags. **Evidence:** lists `ENABLE_PIRACY_TOOLS` / `ENABLE_PIRACY_SEARCH`, but no code reads them (only `ENABLE_GAME_SEARCH`, `ENABLE_SOFTWARE_SEARCH` are consumed by `GameSearchTool`/`SoftwareSearchTool`). **Proposed action:** remove or annotate as unused/legacy in `.env.example`; flag code/admin allowlist similarly.

3. **Location:** `.env.example` / `src/admin/data.ts` CONFIG_ALLOWLIST. **Evidence:** allowlist includes `JELLYFIN_URL`, `EMBEDDING_ENDPOINT`, `ENABLE_PIRACY_*`, which are not read anywhere; omits `JELLYFIN_PUBLIC_LIBRARY`, `JELLYFIN_PUBLIC_MODE` (read by `MediaLibraryTool.isPublicLibraryEnabled`) and `AI_MAX_TOKENS_PARAM`/`AI_<NAME>_MAX_TOKENS_PARAM` (read by `ModelRouter`). **Proposed action:** reconcile allowlist and example with actual env reads.

4. **Location:** `docs/tools.md`. **Evidence:** registry path `src/tools/index.ts` is a barrel re-export; the implementation lives in `src/tools/registry.ts`. Not wrong, but imprecise. **Proposed action:** clarify as `src/tools/registry.ts` (re-exported via `src/tools/index.ts`).

## Missing Coverage

5. **Location:** `docs/architecture.md`. **Evidence:** AppRuntime runs many background tasks (rate-limiter prune, outbox worker + prune, inbox recovery, flow-session TTL prune, media cleanup, retention, startup parser-coverage scan) but docs only name scheduler/retention/digests. **Proposed action:** add "Background tasks" section listing intervals and env knobs.

6. **Location:** `docs/setup.md`. **Evidence:** test harness details (`--no-env-file`, temp DB, global fetch mock, `*Deps` seams) are only in AGENTS.md. **Proposed action:** add a "Testing" section for contributors.

7. **Location:** `docs/tools.md`. **Evidence:** no documentation of tool admission/cost, mutability, opt-in enablement, or `find_tools` lazy loading behavior. **Proposed action:** add short "Execution model" section.

8. **Location:** `.env.example`. **Evidence:** missing `JELLYFIN_PUBLIC_LIBRARY`, `JELLYFIN_PUBLIC_MODE`, `AI_MAX_TOKENS_PARAM` (and per-provider form), `AI_SUPPORTS_IMAGE`, `AI_SUPPORTS_TOOLS`, `AI_STREAM_USAGE`, `AI_SUPPORTS_PARALLEL_TOOLS` (and per-provider forms). **Proposed action:** add annotated entries.

9. **Location:** `docs/api.md` / `docs/architecture.md`. **Evidence:** admin dashboard route list omits `/admin/app.js`, `/admin/style.css` static assets (minor). **Proposed action:** leave as-is or note; low priority.

## Structural Problems

10. **Location:** docs layout. **Evidence:** no single testing doc; harness knowledge lives in AGENTS.md only. **Proposed action:** add testing subsection to setup.md rather than new file.

## Found While Documenting

- `src/admin/data.ts` CONFIG_ALLOWLIST contains env names not read by code (`JELLYFIN_URL`, `EMBEDDING_ENDPOINT`, `ENABLE_PIRACY_SEARCH`, `ENABLE_PIRACY_TOOLS`) and omits some that are read (`JELLYFIN_PUBLIC_LIBRARY`, `AI_MAX_TOKENS_PARAM`, `AI_<NAME>_MAX_TOKENS_PARAM`, `AI_SUPPORTS_*`). Not a functional bug, but admin dashboard config view drifts.
- `src/config/env.ts` validates `AI_TOOL_TIMEOUT_MS` etc but does not validate `WEBHOOK_BODY_READ_TIMEOUT_MS`, `WEBHOOK_ENQUEUE_TIMEOUT_MS`, etc. (they use readInteger defaults in webhooks/config). Not necessarily a bug; validation gap.
- `docs/architecture.md` uses "v8.1 migration" while release is v8.0.1; likely documentation version skew.

## Plan

Files to update:
- `docs/architecture.md` — fix version label; add background tasks section.
- `docs/setup.md` — add Testing section.
- `docs/tools.md` — clarify registry path; add execution model section.
- `.env.example` — add missing env vars; remove/annotate stale opt-in flags.
- `src/admin/data.ts` — (code change) reconcile CONFIG_ALLOWLIST. [FLAGGED: code change, needs decision? Actually safe, but instructions say code read-only; record only.]
- `docs/.audit/docs-audit-2026-11-02.md` — this file.

Progress checklist:
- [x] Fix architecture version label
- [x] Add background tasks section
- [x] Add setup testing section
- [x] Update tools.md registry path + execution model
- [x] Update .env.example missing/stale vars
- [x] Run verification commands
- [x] Consistency pass
