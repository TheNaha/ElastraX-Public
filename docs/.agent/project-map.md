# Project Map — ElastraX

**Recorded Commit: `f791823` (docs/maintenance pass 2026-11-07)
**Date:** 2026-11-07
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
│   ├── index.ts                 # Bootstrap: env validation, schema check, FlowHandler init, AppRuntime start, graceful shutdown
│   ├── runtime/
│   │   ├── AppRuntime.ts        # Service coordinator: provider lifecycles, message queues, scheduler, media cleanup, webhooks
│   │   └── startupDiagnostics.ts# Diagnostic coverage and configuration sanity checks
│   ├── core/
│   │   ├── MessageContext.ts    # Normalized platform-agnostic message context (reply, react, attachments, PTT)
│   │   ├── FlowHandler.ts       # Interactive multi-step wizards state machine in SQLite
│   │   ├── platforms.ts         # Supported platform identifiers and helpers
│   │   └── roleAccess.ts        # Role hierarchy and permission checker
│   ├── providers/
│   │   ├── BotProvider.ts       # Abstract interface implemented by messaging platform providers
│   │   ├── whatsapp.ts          # WhatsApp provider via Baileys with SQLite auth store
│   │   ├── discord.ts           # Discord provider via discord.js
│   │   ├── telegram.ts          # Telegram provider via grammY
│   │   └── process.ts           # Child process tracking and clean termination
│   ├── agent/
│   │   ├── index.ts             # handleIncomingMessage: room lookup, flow checks, slash command routing, LLM loop
│   │   ├── ToolSearchIndex.ts   # Dynamic tool discovery index
│   │   └── PromptBuilder.ts     # System prompt composition (memories, context limits, tool definitions)
│   ├── tools/
│   │   ├── BaseTool.ts          # Abstract base tool with JSON schema definition & metadata
│   │   └── registry.ts          # Builtin tool registry, plugin loader, permission validation
│   ├── plugins/
│   │   └── manifest.ts          # Plugin security manifest parser and permission boundary checker
│   ├── db/
│   │   ├── index.ts             # bun:sqlite driver initialization & Drizzle ORM client
│   │   ├── schema.ts            # Drizzle table definitions (chat_rooms, room_keys, messages, reminders, etc.)
│   │   ├── migrations.ts        # Migration checksum validator, journal reader, integrity enforcement
│   │   └── retention.ts         # Timestamp-aware message & session retention pruning
│   ├── messaging/
│   │   ├── InboxService.ts      # At-least-once inbound message deduplication
│   │   ├── OutboxService.ts     # Outbound message retry & delivery guarantee
│   │   └── roomKeys.ts          # Canonical roomKey (room:<platform>:<id>) resolution
│   ├── webhooks/
│   │   ├── WebhookServer.ts     # Bun.serve HTTP server (/health, /live, /ready, /metrics, /webhook/*)
│   │   ├── adapters/            # Inbound payload adapters (GitHub HMAC, Seerr, Jellyfin)
│   │   └── utils.ts             # Replay cache, rate limiter, body limits, HMAC verification
│   └── utils/
│       ├── logger.ts            # Pino logger instance
│       ├── i18n.ts              # Internationalization dictionaries (en, id)
│       ├── Scheduler.ts         # Cron & reminder background scheduler
│       └── HealthMetrics.ts     # Process and runtime operational telemetry
├── drizzle/
│   ├── migrations/              # Applied SQL migrations with immutable hash history
│   └── meta/_journal.json       # Migration journal with sequential integer versions
└── test/
    ├── setup.ts                 # Preloaded test harness (mocks network, temp DB, clean env)
    └── *.test.ts                # Hermetic integration and unit tests
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
- The loader validates that plugin tool actions are explicitly covered by the manifest's declared permissions before registering.
- Roles (`admin`, `moderator`, `user`) restrict mutating or administrative tools.

### Database & Migrations
- SQLite accessed via Bun's native driver (`bun:sqlite`), wrapped by Drizzle ORM.
- `drizzle/migrations/meta/_journal.json` uses sequential integers (`when: 1..N`).
- Startup checks verify migration hashes against on-disk files; uncommitted or edited migrations abort startup.
- `drizzle-kit push` is disabled. All schema updates must generate migrations (`bun run db:generate`).

---

## 4. Development & Verification Commands

- **Full Local Gate**: `bun run check` (runs ESLint `--max-warnings=0`, `tsc --noEmit`, `bun test`, and `drizzle-kit check`).
- **Single Test**: `bun test --no-env-file test/<FileName>.test.ts` (always include `--no-env-file`).
- **Migration Check**: `bun test --no-env-file test/migration.test.ts`.
- **Schema Drift Check**: `bun run db:generate` (must report `No schema changes, nothing to migrate`).
- **Security Audit**: `bun audit --audit-level=high` (must stay clean).
