# AGENTS.md

Bun 1.3.14 TypeScript bot (WhatsApp/Baileys, Discord, Telegram) with an LLM tool-calling agent, webhook/admin HTTP server, and SQLite via Drizzle. Bun is the only runtime: no Node, npm, or build step (`src/index.ts` runs directly).

## Commands

- Full local gate: `bun run check` (lint -> typecheck -> test -> `drizzle-kit check`).
- CI runs more than `check`. It also runs: gitleaks, `bun audit --audit-level=high`, the migration drift gate (`bun run db:generate` must leave `drizzle/` and `src/db/schema.ts` unchanged), `bun test test/migration.test.ts`, `bun run test:hermetic` (isolated and randomized), `bun run provider:staging`, and a Docker build plus a read-only, non-root container smoke test.
- Single test file: `bun test --no-env-file test/PingTool.test.ts`. Always pass `--no-env-file` so the local `.env` stays out of the run.
- Lint runs with `--max-warnings=0`, so `no-explicit-any` and `no-unused-vars` warnings fail the build. Prefix unused args with `_`. `any` is allowed under `test/`.
- If a test passes in a normal run but fails in CI, rerun it with `bun run test:random` to catch order or mock-leak dependence.

## Test harness (`test/setup.ts`, preloaded via `bunfig.toml`)

- `globalThis.fetch` throws. Tests must inject or mock HTTP clients and never reach the network.
- Each worker gets a temp DB and temp media dirs, and the harness clears app env vars. It fails the run if anything under repo `data/` changes. Never point tests at `data/bot.db`.
- `libsignal` and `whatsapp-rust-bridge` are mocked globally.
- Modules expose `*Deps` objects (e.g. `downloadToolDeps.spawn`) as seams for tests. Patch those and restore them in `afterEach` instead of adding a new `mock.module`, because `mock.module` leaks across files.
- To get a fresh module, import it with a cache-busting query: `import(\`../src/db/index.ts?case=...\`)`.

## Database / migrations

- Edit `src/db/schema.ts`, then run `bun run db:generate`. Never use `db:push` (it is disabled). `db:migrate` takes a backup first. The app also migrates itself on startup (`ensureDatabaseSchema`).
- `drizzle/migrations/meta/_journal.json` uses small sequential integers for `when` (1..N), not timestamps. `src/db/migrations.ts` validates these values and hardcodes some of them (`ROOM_KEY_MIGRATION_WHEN`, `IDENTITY_PK_MIGRATION_WHEN`, and a checksum allowance keyed by journal position). Applied migrations are hash-checked, so never edit a shipped `.sql` file. After `drizzle-kit generate`, rename the new file and its journal tag to the next `00NN_` number, set `when` to the next integer, and make sure a matching `meta/00NN_snapshot.json` exists. Snapshots are missing for some old migrations, and drizzle-kit diffs against the newest snapshot.
- The SQLite driver is `bun:sqlite`. `bunfig.toml` sets `peer = false` so `better-sqlite3` is not installed; don't add it.
- Durable room references use the canonical `room:<platform>:<id>` key (`ctx.roomKey`). `ctx.chatId` is the raw provider ID and is used only for provider I/O. See `docs/room-identity-migration.md`.

## Dependencies

- `package.json` `overrides` are security pins. When `bun audit` reports something, bump them to the fixed versions. Audit must stay clean.
- TypeScript is pinned exactly because typescript-eslint 8.x caps its peer range below 6.1. Don't upgrade to TS 7 until typescript-eslint supports it.
- Baileys is pinned to `7.0.0-rc14`. It nests its own pino@9 alongside the root pino@10; that is expected.
- The Dockerfile and CI install with `--frozen-lockfile`. Commit `bun.lock` after any dependency change. Never commit `package-lock.json`.
- If `bun install` fails with `PermissionDenied: failed copying files from cache`, delete `~/.bun/install/cache` and reinstall.

## Code layout notes

- `src/index.ts` (bootstrap) -> `src/runtime/AppRuntime.ts` starts providers, the scheduler, and `src/webhookServer.ts`. All messages are normalized into `MessageContext` and handled by `src/agent/index.ts`.
- Tools extend `BaseTool` and are registered in `src/tools/registry.ts`. That file also loads any `.ts` in `src/plugins/` as a plugin. A plugin must export a `pluginManifest` whose permissions cover its tools, otherwise it is refused.
- User-facing strings go through `t()` in `src/utils/i18n.ts`. Add every key to both the `en` and `id` blocks.
- ESLint 10 flat config: every config object needs a `name`.
- `modal/` is a separate, experimental Python vLLM adapter. It is not part of the bot or CI.
- The `AUDIT*.md` files in the repo root are point-in-time audit reports, not specs.

## Project map
A map of this project lives at `docs/.agent/project-map.md`. Read it at the start of any task that involves understanding how the project works. It records the commit it was written at; if HEAD has moved significantly, verify against the code before relying on it. Update it if you find it wrong.
