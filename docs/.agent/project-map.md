# Project Map — ElastraX

**Recorded Commit:** `9e16190` (code through maintenance pass 6; docs resynced 2026-11-19)
**Date:** 2026-11-19
**Runtime:** Bun 1.3.14 (TypeScript direct execution, no Node/npm build step)

---

## 1. Overview & Core Philosophy

ElastraX is a production-grade multi-platform AI assistant and tool-calling agent runtime.
It connects WhatsApp (via Baileys), Discord (via discord.js), and Telegram (via grammY) with an LLM conversational core, an interactive multi-step flow engine, durable SQLite persistence, and an integrated HTTP webhook/admin server.

---

## 2. Directory Structure & Key Symbols

```
ElastraX/
├── src/
│   ├── index.ts                 # Bootstrap: env validation, schema check, FlowHandler init, AppRuntime start, signal shutdown
│   ├── webhookServer.ts         # Compatibility shim re-exporting src/webhooks/*
│   ├── config/
│   │   ├── env.ts               # validateEnv: required vars, bounds, secrets, URLs
│   │   ├── llm.ts               # Provider resolution and Cloudflare base-URL shorthand
│   │   ├── runtime.ts           # read*Env helpers and resolved runtime defaults
│   │   ├── database.ts          # Database path/timeout resolution
│   │   └── version.ts           # APP_VERSION / APP_RELEASE_TAG
│   ├── runtime/
│   │   ├── AppRuntime.ts        # Service coordinator: providers, queues, scheduler, media cleanup, webhooks
│   │   └── startupDiagnostics.ts# Startup parser-coverage scan
│   ├── core/
│   │   ├── MessageContext.ts    # Normalized platform-agnostic message context
│   │   ├── FlowHandler.ts       # Interactive multi-step state machine in SQLite
│   │   ├── platforms.ts         # Supported platform identifiers and helpers
│   │   ├── roleAccess.ts        # Role satisfaction rule (exact role; owner universal)
│   │   ├── roomKeyFormat.ts     # Canonical room:<platform>:<id> format (only definition)
│   │   ├── constants.ts         # Shared constants (flow cancel commands, limits)
│   │   └── prompts.ts           # Default system prompt
│   ├── agent/
│   │   ├── index.ts             # handleIncomingMessage: room lookup, flows, slash routing, LLM loop
│   │   ├── ToolSearchIndex.ts   # Dynamic tool discovery index
│   │   ├── roomKey.ts           # Room-key resolution for agent lane
│   │   ├── messageId.ts         # Event-id derivation for inbox dedupe
│   │   └── toolProgress.ts      # Live [i/N] tool status message
│   ├── ai/
│   │   ├── client.ts            # OpenAI-compatible chat client (+ streaming)
│   │   ├── streaming.ts         # Throttled edit-based streaming
│   │   ├── sse.ts               # SSE parser
│   │   ├── turnBudget.ts        # Per-turn tool-call/result budgets
│   │   ├── errors.ts            # AIProtocolError
│   │   ├── summaryStore.ts      # Rolling conversation summaries
│   │   └── types.ts             # AI message/tool types
│   ├── providers/
│   │   ├── BotProvider.ts       # Abstract provider interface and status enum
│   │   ├── whatsapp.ts          # WhatsApp via Baileys with SQLite auth store
│   │   ├── discord.ts           # Discord via discord.js
│   │   ├── telegram.ts          # Telegram via grammY
│   │   ├── telegramText.ts      # Telegram text/markdown helpers
│   │   ├── whatsappParser.ts    # Raw Baileys message parser
│   │   ├── media.ts             # Shared provider media helpers
│   │   ├── process.ts           # Child-process tracking and termination
│   │   ├── semaphore.ts         # Concurrency limits
│   │   ├── ssrf.ts              # SSRF-safe URL validation
│   │   ├── errors.ts            # ProviderError
│   │   ├── jellyfin/JellyfinClient.ts
│   │   └── seerr/SeerrClient.ts
│   ├── tools/
│   │   ├── BaseTool.ts          # Abstract tool with JSON schema and metadata
│   │   ├── access.ts            # isToolAccessible: the one visibility predicate (registry, /menu, /find_tools, slash)
│   │   ├── registry.ts          # Builtin registry, plugin loader, admission, mutability table
│   │   ├── index.ts             # Registry re-export
│   │   └── *Tool.ts             # One file per built-in tool
│   ├── plugins/
│   │   ├── manifest.ts          # Manifest parser and permission boundaries
│   │   └── ReloadPluginsTool.ts # Owner-only /reload
│   ├── flows/
│   │   └── registry.ts          # Built-in flow processor registration
│   ├── db/
│   │   ├── index.ts             # bun:sqlite handle, Drizzle client, startup migration
│   │   ├── schema.ts            # Drizzle table definitions
│   │   ├── migrations.ts        # Journal/checksum validation and schema contract
│   │   ├── rooms.ts             # Room-key registry and resolution (schema-catalog probes memoised per handle)
│   │   ├── runtime.ts           # Runtime lease table
│   │   ├── retention.ts         # Message/delivery retention pruning
│   │   ├── maintenance.ts       # Retention policy parsing and scheduler
│   │   └── backup.ts            # Backup/restore/preflight support
│   ├── messaging/
│   │   ├── InboxService.ts      # At-least-once inbound deduplication
│   │   ├── OutboxService.ts     # Durable outbound retry and delivery
│   │   └── roomKeys.ts          # Runtime room-key facade
│   ├── webhooks/
│   │   ├── WebhookServer.ts     # Bun.serve routes (/health, /live, /ready, /metrics, /webhook/*)
│   │   ├── config.ts            # Webhook env parsing and secret rules
│   │   ├── types.ts             # Delivery job/enqueue types
│   │   ├── utils.ts             # Replay cache, rate limiter, body limits, HMAC
│   │   ├── rooms.ts             # Webhook destination resolution
│   │   └── adapters/            # GitHub, Seerr, Jellyfin, Grafana, Apprise, generic
│   ├── admin/
│   │   ├── auth.ts              # Token exchange, session cookie, CSRF, login throttle
│   │   ├── routes.ts            # /admin pages and /admin/api/* views and actions
│   │   └── data.ts              # Read-only data collectors for the dashboard
│   ├── types/                   # Shared type declarations
│   └── utils/                   # Shared infrastructure and services (see each file's header)
│                                #   toolAccess.ts — shared tool guards (binding lookup, permission check)
├── scripts/                     # Operational CLIs (dbBackup, dbRoomKeys, ciDiagnostics, retention, …)
├── drizzle/
│   ├── migrations/              # Applied SQL migrations with immutable hash history
│   └── migrations/meta/_journal.json # Sequential integer versions
└── test/
    ├── setup.ts                 # Preloaded harness (network throw, temp DB, clean env)
    └── *.test.ts                # Hermetic unit/integration tests
```

---

## 3. Core Architectural Patterns

### Message Normalization (`MessageContext`)
- Every provider translates incoming socket/API payloads into `MessageContext`.
- Core conversational logic never interacts with raw Baileys/Discord/Telegram objects directly.
- Standard capabilities: `reply()`, `react()`, `sendMedia()`, `downloadMedia()`, `deleteMessage()`.

### Canonical Room Key vs Transport Chat ID
- `ctx.chatId`: Raw transport ID (e.g. `123456789@g.us`, Discord snowflake, Telegram chat ID) used solely for provider I/O.
- `ctx.roomKey`: Durable canonical room identifier (`room:<platform>:<id>`). All persistence (rooms, history, reminders, subscriptions, outbox) indexes against `roomKey`.

### Tool Calling & Plugin Sandboxing
- Built-in tools extend `BaseTool`.
- Dynamic tools in `src/plugins/` must export a `pluginManifest`.
- The loader validates that plugin tool actions are explicitly covered by the manifest's declared permissions before registering, and rejects a tool whose name or alias collides with an already-admitted tool.
- Roles (`user`, `premium`, `admin`, `owner`) restrict mutating or administrative tools. A check needs the exact role; `owner` satisfies every role and `user` is implicit.

### Database & Migrations
- SQLite accessed via Bun's native driver (`bun:sqlite`), wrapped by Drizzle ORM.
- `drizzle/migrations/meta/_journal.json` uses sequential integers (`when: 1..N`).
- Startup checks verify migration hashes against on-disk files; uncommitted or edited migrations abort startup.
- `drizzle-kit push` is disabled. All schema updates must generate migrations (`bun run db:generate`).
- `REQUIRED_INDEXES` in `src/db/migrations.ts` is the index contract; `test/migration.test.ts` asserts set equality with a freshly migrated database, so a new index must be listed.

---

## 4. Development & Verification Commands

- **Full Local Gate**: `bun run check` (runs ESLint `--max-warnings=0`, `tsc --noEmit`, `bun test`, and `drizzle-kit check`).
- **Single Test**: `bun test --no-env-file test/<FileName>.test.ts` (always include `--no-env-file`).
- **Migration Check**: `bun test --no-env-file test/migration.test.ts`.
- **Schema Drift Check**: `bun run db:generate` (must report `No schema changes, nothing to migrate`).
- **Security Audit**: `bun audit --audit-level=high` (must stay clean).
