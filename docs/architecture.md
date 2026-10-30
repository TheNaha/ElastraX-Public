# Architecture & Design

ElastraX is designed with a domain-driven architecture that completely decouples the messaging platforms (WhatsApp, Discord) from the core conversational logic (the Agent).

## Core Concepts

### 1. The `MessageContext` Interface
The most critical part of the architecture is the `src/core/MessageContext.ts` wrapper. 
Every incoming message from any platform is normalized into a standard `MessageContext` object. This interface exposes platform-agnostic methods like:
- `ctx.reply()`
- `ctx.react()`
- `ctx.sendMedia()`
- `ctx.downloadMedia()`
- `ctx.deleteMessage()`

This guarantees that the core AI agent (`src/agent/index.ts`) does not need to know whether it's talking to WhatsApp or Discord.

### 2. Platform Providers
Platform implementations live in `src/providers/` and implement the `BotProvider` interface:
- **WhatsApp**: Built using Baileys (`src/providers/whatsapp.ts`). Handles socket reconnections, media downloading via buffers, and pairing logic.
- **Discord**: Built using discord.js (`src/providers/discord.ts`). Normalizes Discord guilds/channels and attachments.

### 3. The Agent Loop (`src/agent/index.ts`)
The `handleIncomingMessage` function is the single entry point for all normalized messages. It performs the following pipeline:
1. **Flow Interception**: Checks if the user is in an active interactive flow (e.g. PDF multi-image collection).
2. **Explicit Commands**: Routes slash commands directly to their tool implementations (bypassing the LLM).
3. **Intent / Rule Checking**: Decides if the bot should reply (e.g., ignoring group messages where the bot isn't mentioned).
4. **LLM Inference**: Fetches chat history, builds the context, and invokes the `AIClient`.
5. **Tool Execution Loop**: If the LLM returns tool calls, the agent executes them securely and feeds the result back until a final answer is generated.

### 4. Interactive State Management (`FlowHandler.ts`)
For complex actions that require multiple user steps (like merging 5 PDFs), `FlowHandler` manages room-bound state in SQLite. Sessions are platform/room/user scoped, versioned against lost updates, and resumed after restart.

### 5. Canonical Room Identity
The v8.1 migration stores a canonical `room:<platform>:<remoteRoomId>` key for every durable room reference. `ctx.chatId` remains the raw provider room ID for provider I/O; `ctx.roomKey` is used for rooms, history, reminders, subscriptions, inbox, and outbox. See [Room Identity Migration](./room-identity-migration.md).

### 6. Multi-Provider AI Router (`ModelRouter.ts`)
The AI layer features a highly resilient Failover Router:
- Allows configuration of multiple providers (e.g., Modal, Gemini, Ollama, Cloudflare).
- If the primary tier fails (HTTP 5xx, timeout, or rate-limit), the router circuit-breaks and silently falls back to a lower tier without dropping the user's message.
- Providers are instantiated lazily and their health is tracked in `src/utils/HealthMetrics.ts`.

### 7. Storage & Long-Term Memory
- **Database**: SQLite via Bun's built-in `bun:sqlite` driver with Drizzle ORM (`src/db/schema.ts`). `better-sqlite3` is never used (`bunfig.toml` sets `peer = false`).
- **Memory (RAG)**: The `MemoryTool` allows the AI to explicitly store facts about users. These facts are queried and injected into the system prompt, providing persistent long-term memory across chat sessions.

## 8. Telegram Provider

`src/providers/telegram.ts` implements the same `BotProvider` contract using grammy. It is optional: without `TELEGRAM_BOT_TOKEN` it reports `not_configured` and never blocks boot. Because a Telegram user id is a numeric snowflake that can never match `BOT_OWNER_JID`, a deployment that enables Telegram must also set `BOT_OWNER_TELEGRAM_ID`, otherwise the platform starts with no owner and every owner-only tool is unreachable. `BOT_OWNER_DISCORD_ID` exists for the same reason on Discord; both fall back to `BOT_OWNER_JID` when unset.

## 9. Durable Delivery (Inbox / Outbox)

`src/messaging/InboxService.ts` and `src/messaging/OutboxService.ts` provide at-least-once delivery:

- Inbound events are deduplicated by `senderId:messageId` and recorded in the inbox; replayed events log `Provider event already completed`.
- Outbound replies are enqueued to the outbox and retried on failure; `WebhookServer.registerEnqueuer()` switches `/webhook` to the durable path and returns `202` only after durable acceptance.
- `src/runtime/AppRuntime.ts` registers provider senders at boot and runs an hourly outbox prune plus stranded-inbox recovery.

## 10. Scheduler, Reminders, and Scheduled Tasks

`src/utils/Scheduler.ts` drives cron/countdown reminders from a background task queue. A reminder whose text starts with `/task ` is executed as an agent turn in its room at fire time instead of being delivered as text (scheduled agent tasks). Scheduled tasks are off unless `SCHEDULED_TASKS_ENABLED=true` and the room is listed in `SCHEDULED_TASKS_ALLOWED_ROOMS`; they are denied every mutating tool and bounded by daily/per-room ceilings.

## 11. Retention

`src/db/retention.ts` deletes terminal inbox/outbox rows, terminal deliveries, sent reminders, flow sessions, and old messages according to the `RETENTION_*` knobs. It defaults to dry-run. `scripts/runRetention.ts` exposes `--apply`. Retention overlaps with AppRuntime's hourly outbox prune; deletes are idempotent.

## 12. Digests

`src/utils/DigestService.ts` produces nightly per-room conversation summaries and a weekly Jellyfin "new media" rollup, fired once per day/week at `DIGEST_HOUR_UTC` with exactly-once delivery via markers in `app_kv`. On-demand digests are available in-chat via `/digest [hours]`.

## 13. Admin Dashboard

`/admin` on the same listener as webhook intake is a read-mostly operator dashboard. It requires `METRICS_AUTH_TOKEN` of at least 24 bytes; without it every `/admin` path returns `404`. Authentication exchanges the token for an `HttpOnly; SameSite=Strict` session cookie plus a CSRF token sent in `x-admin-csrf`. Routes are documented in `docs/api.md`.

## 14. Logging and Error Handling

- Logging uses Pino (`src/utils/logger.ts`). `LOG_LEVEL` controls verbosity (`trace`/`debug`/`info`/`warn`/`error`/`fatal`, default `info`). `NODE_ENV=production` emits raw JSON lines; otherwise `pino-pretty` is used. Child loggers are created per module via `logger.child({ module })`.
- Provider failures surface as `ProviderError` subclasses with a `code` (`NOT_CONFIGURED`, `START_FAILED`, `NOT_CONNECTED`, `INVALID_TARGET`, `UNSUPPORTED`, `OPERATION_FAILED`, `STALE_LIFECYCLE`, `PERMISSION_DENIED`) and a `retryable` flag.
- AI protocol failures surface as `AIProtocolError` (`invalid_response`, `no_choices`, `invalid_chunk`, `invalid_sse`, `sse_buffer_limit`, `empty_stream`, `incomplete_stream`, `empty_response`, `response_too_large`).
- Webhook request failures surface as `WebhookRequestError` with an HTTP status; the server maps them to the response status.
- Validation failures at startup throw after logging every error; the process does not start with an invalid environment.
