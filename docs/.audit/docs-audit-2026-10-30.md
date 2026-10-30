# Documentation Audit — ElastraX

**Date:** 2026-10-30
**Scope:** whole repository (README, docs/, .env.example, inline doc comments)
**Baseline:** code on branch `maintenance/2026-10-30`.

## Stale or Incorrect

- `docs/architecture.md` states the database uses `better-sqlite3` (or Bun's native SQLite). The runtime uses `bun:sqlite` exclusively (`bunfig.toml` sets `peer = false`); `better-sqlite3` is never installed. Stale.
- `.env.example` header brands the file "ElastraX v7" while the release is `8.0.1` (`package.json`). Stale branding.
- `README.md` and `docs/deployment.md` describe the pinned FFmpeg build as `8.1.2`; `Dockerfile` pins `FFMPEG_BUILD=8.1.3-24-g92611900bb` (SHA-verified). Stale version.
- `README.md` describes the bot as WhatsApp and Discord only; `src/providers/telegram.ts` implements a third platform (grammy) and `.env.example` exposes `TELEGRAM_BOT_TOKEN` / `BOT_OWNER_TELEGRAM_ID`. Missing platform in top-level description.
- `README.md` / `docs/README.md` reference `docs/flows.md`, which does not exist. Broken link.
- `docs/architecture.md` describes only WhatsApp/Discord providers and omits Telegram, the admin dashboard, inbox/outbox delivery, the scheduler, retention, and digest services.
- `.env.example` sets `AI_MAX_TOKENS=20480` while the code default is `2048` (`src/config/runtime.ts`). The example overrides the documented default without explanation.
- `docs/tools.md` is a hand-maintained catalog; verified against `src/tools/registry.ts` and `readonly name = ...` declarations (31 tools).

## Missing Coverage

- No document for the Telegram provider or its owner-seeding requirement (`BOT_OWNER_TELEGRAM_ID`).
- No `docs/flows.md` despite being referenced.
- No documentation for scripts in `scripts/`.
- No documentation of logging conventions (Pino, `LOG_LEVEL`, pretty vs JSON) beyond `src/utils/logger.ts`.
- No documentation of error-handling conventions (`ProviderError` codes, `AIProtocolError`, `WebhookRequestError`).
- Advanced tuning env vars not in `.env.example`: `MESSAGE_QUEUE_*`, `AI_MAX_*` turn-budget vars, `ALLOW_TOOLS`, `LONG_TERM_MEMORY`, `MEDIA_STORAGE_MAX_*`, `ELASTRAX_DB_SYNCHRONOUS`, `ELASTRAX_DOWNLOAD_DIR`, `ELASTRAX_FFMPEG_DIR`, `ELASTRAX_MEDIA_DIR`, `EMBEDDING_DIMENSION`, `ENABLE_MEDIA_LIBRARY`, `TRANSCRIBE_MODE`, `WA_AUTH_IMPORT_DIR`, `JELLYFIN_URL`/`SEERR_URL` aliases, `AI_SUPPORTS_*` global flags.
- Inbox/outbox durable delivery and the `registerEnqueuer` 202 contract only partially documented.

## Structural Problems

- `docs/README.md` index lists `flows.md` which is absent.
- Version branding inconsistent (`v7` in `.env.example` vs `v8.0.1` elsewhere).
- No single home for "scripts and CLI commands"; scattered across README and runbooks.
- `docs/.audit/` directory did not exist; audit output had no canonical location.

## Found While Documenting

- Webhook compatibility env vars are read dynamically via `readCompatibilityWindow(env, prefix)` in `src/webhooks/config.ts`; not stale.
- `AI_<NAME>_*` and `ROLE_PRIV_*` vars are resolved dynamically by provider/role name; cannot be enumerated exhaustively in `.env.example`.
- `src/db/index.ts` reads `ELASTRAX_DB_PATH` (documented) plus `ELASTRAX_DB_SYNCHRONOUS` (undocumented tuning).
- `src/tools/MediaLibraryTool.ts` treats any of `JELLYFIN_PUBLIC_LIBRARY`, `MEDIA_PUBLIC_LIBRARY`, `ENABLE_MEDIA_LIBRARY`, `JELLYFIN_PUBLIC_MODE` as enabling public library mode.
- `src/utils/ConfigService.ts` reads `ALLOW_TOOLS` and `LONG_TERM_MEMORY` as global defaults overridable per chat.
- No new code bugs identified in this pass beyond those already tracked in `docs/maintenance/audit-2026-10-30.md`.

## Plan

Files to update/create:

- `docs/.audit/docs-audit-2026-10-30.md` — this audit.
- `docs/architecture.md` — fix SQLite statement; add Telegram, admin dashboard, inbox/outbox, scheduler, retention, digest, logging/error conventions.
- `docs/flows.md` — create.
- `docs/scripts.md` — create.
- `docs/README.md` — add scripts link; flows now exists.
- `README.md` — add Telegram; fix FFmpeg version.
- `docs/setup.md` — add Telegram setup; scripts reference; logging/error conventions.
- `docs/deployment.md` — fix FFmpeg version.
- `.env.example` — rebrand header to v8; document advanced tuning vars; clarify AI_MAX_TOKENS default.

Progress checklist:

- [x] Audit written
- [x] Architecture doc updated
- [x] flows.md created
- [x] scripts.md created
- [x] docs index updated
- [x] README updated
- [x] setup.md updated
- [x] deployment.md updated
- [x] .env.example updated
- [x] Validation run
