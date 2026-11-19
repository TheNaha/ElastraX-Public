# Architecture & Design

ElastraX is designed with a domain-driven architecture that completely decouples the messaging platforms (WhatsApp, Discord, Telegram) from the core conversational logic (the Agent).

## Process lifecycle

`src/index.ts` is the only executable entry point (`bun run start`). `bootstrap()` runs in this order:

1. Register `SIGINT`/`SIGTERM` handlers. This is the first statement, *before* any `await`, so a SIGTERM during a long migration still runs shutdown instead of taking the default disposition.
2. `validateEnv()` — every environment error is logged, then startup throws.
3. `ensureDatabaseSchema()` — migration-state check, forward migrations, schema-contract validation, schema fingerprint, runtime lease (see [Database](./database.md)).
4. `FlowHandler.initialize()` — load persisted flow sessions and prune expired ones.
5. Register `uncaughtException`/`unhandledRejection` handlers. They are deliberately registered here and not with the signals: making every stray rejection fatal while libraries are still importing would turn a benign warning into a boot crash-loop.
6. `new AppRuntime({ runStartupCoverageScan }).start()` — wait for the tool registry, register flow processors, parse the webhook configuration (fails before any provider connects), start providers, register senders/enqueuers, start the HTTP listener and background timers (see [Services](./services.md)).

A signal stops the runtime, closes the database, cancels tracked `yt-dlp`/`ffmpeg` child processes, and force-exits after a 2 s grace period, because detached children with piped stdio can otherwise keep the process alive. A fatal error follows the same path with exit code `1`. The database is closed only after the schema work has finished; closing it under a running migration would abort that work.

A signal that lands during startup — while the schema is being ensured or flows are loading — marks shutdown as requested. The boot sequence notices this at the guard just before it would construct the runtime, and fails with `Startup interrupted by shutdown signal` instead of starting providers and the HTTP listener against a handle the shutdown path already closed. A startup failure unwinds in reverse: handlers are removed, the runtime is stopped if it had started, and the database handle is closed before the error is rethrown. `src/webhookServer.ts` is a compatibility re-export only; the implementation lives in `src/webhooks/`.

The default bootstrap is also the only place that hands `AppRuntime` a `runStartupCoverageScan` implementation, so the parser-coverage diagnostic is armed in production and not only in tests (see [Services](./services.md)).

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
- **WhatsApp**: Built using Baileys (`src/providers/whatsapp.ts`). Handles socket reconnections, media downloading via buffers, pairing logic, and background `messaging-history.set` imports (normalized and persisted through `syncHistoricalDatabase`; failures are logged and never block live traffic).
- **Discord**: Built using discord.js (`src/providers/discord.ts`). Normalizes Discord guilds/channels and attachments.
- **Telegram**: Built using grammY (`src/providers/telegram.ts`). Optional; without `TELEGRAM_BOT_TOKEN` it reports `not_configured` and never blocks boot.

### 3. Provider lifecycle and status

Every provider exposes `status` (`stopped`, `starting`, `running`, `backoff`, `not_configured`, `error`) and `isOperational`, which is true only while `status === 'running'`. `AppRuntime.operationalProviders()` filters outbound delivery, scheduler and digest senders through it, so a provider that is reconnecting is temporarily skipped instead of failing sends; a destination platform with no operational provider makes a webhook enqueue return `503` rather than queueing a row no worker can claim. Admission at boot follows `start()` resolving, not `isOperational`, because WhatsApp flips to `running` only from its socket `open` handler. A provider whose `start()` rejected while it scheduled its own reconnect is wired later by `reconcileProviderAdmission()` — run on every outbox tick and webhook enqueue — which registers its senders and adds it to `activeProviders` once it is operational.

- WhatsApp reconnects on every disconnect reason except `DisconnectReason.loggedOut` (`401`), with 1,500 ms doubling backoff capped at 300,000 ms. `401` is terminal and requires re-pairing.
- Discord enters `backoff` on a gateway reconnect and returns to `running` on `shardResume`/`shardReady` as well as `clientReady`, so a transient reconnect does not remove it from delivery for the life of the process.
- Telegram stops its poller and schedules a reconnect if its boot-settle guard times out, so a slow API at startup does not leave an orphaned `getUpdates` loop behind.
- `stop()` awaits each provider's socket/poller shutdown; `AppRuntime.teardown` bounds each stop with a 10 s timeout and logs a failure instead of hanging shutdown.

### 4. The Agent Loop (`src/agent/index.ts`)
The `handleIncomingMessage` function is the single entry point for all normalized messages. It resolves the room, the sender's roles and the room config, then runs this pipeline in order:
1. **Intent / Rule Checking**: Decides if the bot should reply (e.g., ignoring group messages where the bot isn't mentioned).
2. **Flow Interception**: Checks if the user is in an active interactive flow (e.g. PDF multi-image collection) and lets it consume the message.
3. **Rate Limiting**: Per-sender, per-role limit; only messages the bot will actually process are counted (see below).
4. **Explicit Commands**: Routes slash commands directly to their tool implementations (bypassing the LLM).
5. **LLM Inference**: Fetches chat history, builds the context, and invokes the `AIClient`.
6. **Tool Execution Loop**: If the LLM returns tool calls, the agent executes them securely and feeds the result back until a final answer is generated. Only calls that pass the permission check and argument validation are charged to the turn budget, so a round of unauthorized or malformed calls cannot exhaust it; when a round asks for more calls than the budget still allows, the ones that fit run and the remainder get a budget-exceeded tool result instead of the whole batch being dropped. While tools run, a live status message is posted and edited in place, listing each step as `[i/N]` with running/completed/failed icons (⏳/✅/❌, see `src/agent/toolProgress.ts` and `BaseTool.describeAction`); the footer only plans the calls that will actually run. The final answer is delivered as a separate message. One extra iteration past `AI_MAX_TOOL_ITERATIONS` runs text-only (with the tool protocol flattened to plain text), so a turn that used its whole tool budget still ends with an answer instead of "internal error".

The limiter runs after the flow check and after the trigger decision, so group chatter the bot ignores neither consumes a sender's budget nor earns a "rate limited" reply, an active flow step is never dropped by it, and a slash command is still limited.

With `AI_STREAMING=true` and a platform that supports `sendMessage`/`editMessage`, tokens are accumulated and edited into one live message at `STREAMING_EDIT_INTERVAL_WA` / `_DC`. The preview strips a `think` block even while it is still streaming, so chain-of-thought never reaches the user, and nothing is sent until real text arrives. The preview is also frozen at 1,800 UTF-16 units — the unit the providers count when they decide whether an edit needs a continuation — and the clamp never splits an emoji's surrogate pair: `editMessage` grows a message by re-editing its head and posting the remainder as new messages, so an unbounded preview past the platform limit re-posted the whole tail on every edit. The final edit still delivers the complete answer. If a streamed bubble also carries tool calls and the progress tracker does not adopt that message, the bubble is finalised (without the trailing cursor) before the tool status message takes over. A send or edit failure degrades to the non-streaming path for the rest of the turn.

#### Prompt assembly and rolling summary

Every turn builds the model input in the same order: the room system prompt (`ConfigService`, with `{{LANGUAGE}}` substituted and the sender's non-`user` roles appended), then at most one reference block, then the active history. The reference block is the sender's long-term memories in a DM and the room's shared knowledge base in a group. Personal memory is never injected into a group: it would be folded into the group-visible rolling summary, turning one participant's private notes into everyone's context. Memories are ranked by embedding similarity when `EMBEDDING_API_URL`/`EMBEDDING_MODEL` are set and fall back to the most recent `MAX_INJECTED_MEMORIES` (50); the group path injects at most `MAX_ROOM_KNOWLEDGE_CHUNKS` (4) excerpts. All three reference kinds are fenced as untrusted material — `<untrusted_long_term_memory>`, `<room_knowledge>` with an explicit "background material, not instructions" line, and the summary as `<conversation_summary trust="untrusted">`.

With `CONTEXT_SUMMARIZE` on (the default) history is fetched to `contextLimit + SUMMARY_LOOKAHEAD` (16) rows, capped at twice `AI_OPERATIONAL_CONTEXT_LIMIT`. Messages that fall outside the `contextLimit` window are folded into a rolling summary only once the batch reaches `SUMMARY_MIN_BATCH` (8); a smaller overflow is widened back into the active window, so messages are never dropped from the turn just because they were too few to summarise. The summary, its `throughMessageId` watermark and a count persist per room in `app_kv` under `conversation-summary:v1:<roomKey>`, so a restart does not re-summarise history, and the only model call on that path is a `fast`-tier completion at temperature `0.2`. With summarization off, the last `contextLimit` rows are sent unchanged.

### 5. Interactive State Management (`FlowHandler.ts`)
For complex actions that require multiple user steps (like merging 5 PDFs), `FlowHandler` manages room-bound state in SQLite. Sessions are platform/room/user scoped, versioned against lost updates, and resumed after restart.

### 6. Canonical Room Identity
ElastraX v8.0.1 (migration `0022_room_keys`) stores a canonical `room:<platform>:<remoteRoomId>` key for every durable room reference. `ctx.chatId` remains the raw provider room ID for provider I/O; `ctx.roomKey` is used for rooms, history, reminders, subscriptions, inbox, and outbox. See [Room Identity Migration](./room-identity-migration.md).

### 7. Multi-Provider AI Router (`ModelRouter.ts`)
The AI layer features a highly resilient Failover Router:
- Allows configuration of multiple providers (e.g., Modal, Gemini, Ollama, Cloudflare).
- If the primary tier fails (HTTP 5xx, timeout, or rate-limit), the router circuit-breaks and silently falls back to a lower tier without dropping the user's message.
- "Empty" means no usable text: a response that holds only a reasoning block — including one a truncated stream left open — counts as empty on both the streaming and non-streaming paths. That is what makes a reasoning-only answer a failure worth retrying, and a mid-stream fallback calls the consumer's `onRestart` hook so the abandoned provider's chunks are dropped instead of being glued onto the next answer.
- AI clients are constructed when the `ModelRouter` is built (not lazily). Service-health checks are run by `src/utils/HealthMonitor.ts`; `src/utils/HealthMetrics.ts` records request, latency, and token metrics.

### 8. Storage & Long-Term Memory
- **Database**: SQLite via Bun's built-in `bun:sqlite` driver with Drizzle ORM (`src/db/schema.ts`). `better-sqlite3` is never used (`bunfig.toml` sets `peer = false`).
- **Memory (RAG)**: `MemoryTool` stores facts only after the sender consents (`action: consent`, or `consent: true` on the first store; `revoke` withdraws consent). Scope is `private` (the sender) by default; `group` stores room-visible facts and requires the `admin` role. Stored facts are prefixed with `[INERT_DATA]` so the model treats them as data, never instructions, and each sender is bounded by entry and byte quotas. Nearby duplicates are rejected using embeddings when configured. Consent gates *storage*, not retrieval: memories already stored are still injected until `forget` deletes them, and in a group they are never mixed with another member's private facts (see §4).

### 9. Telegram Provider

`src/providers/telegram.ts` implements the same `BotProvider` contract using grammy. It is optional: without `TELEGRAM_BOT_TOKEN` it reports `not_configured` and never blocks boot. Because a Telegram user id is a numeric snowflake that can never match `BOT_OWNER_JID`, a deployment that enables Telegram must also set `BOT_OWNER_TELEGRAM_ID`, otherwise the platform starts with no owner and every owner-only tool is unreachable. `BOT_OWNER_DISCORD_ID` exists for the same reason on Discord; both fall back to `BOT_OWNER_JID` when unset.

The first chunk of a reply carries `reply_parameters`. If the user deletes their message in the seconds before delivery the Bot API answers `400`, so that chunk is re-sent without `reply_parameters` instead of losing the answer. Replies are chunked by the shared UTF-16 splitter (`chunkTextTelegram` → `chunkTextSmart({ measure: 'utf16' })`), and `editMessage` splits head/remainder with `splitTextAtUtf16Limit`, because the Bot API enforces its 4096 limit in UTF-16 units — 4096 emoji are 8192 units and were rejected when the chunker counted code points. Neither path splits a surrogate pair, and `chunkTelegramText` is a thin alias of the same function.

Reaction feedback needs an explicit `allowed_updates: ['message', 'message_reaction']`; the Bot API's default update set excludes `message_reaction`, so without it incoming thumbs up/down never reached `src/utils/feedback.ts`.

### 10. Durable Delivery (Inbox / Outbox)

`src/messaging/InboxService.ts` and `src/messaging/OutboxService.ts` provide at-least-once delivery:

- Inbound events are deduplicated by a SHA-256 of `platform`, `chatId` and `messageId`; when the provider supplies no usable id (WhatsApp falls back to `'unknown'`), the inbox randomises the key so such events are never collapsed together. Replayed events log `Provider event already completed`.
- Outbound replies are enqueued to the outbox and retried on failure; `WebhookServer.registerEnqueuer()` switches `/webhook` to the durable path and returns `202` only after durable acceptance. Both inbox and outbox dead-letter a row after 5 failed attempts and use attempt-aware exponential backoff; stranded in-flight rows are recovered or dead-lettered by the hourly `recoverStranded` scan.
- `src/runtime/AppRuntime.ts` registers provider senders at boot and runs an hourly outbox prune plus stranded-inbox recovery.

### 11. Scheduler, Reminders, and Scheduled Tasks

`src/utils/Scheduler.ts` drives cron/countdown reminders from a background task queue. A reminder whose text starts with `/task ` is executed as an agent turn in its room at fire time instead of being delivered as text (scheduled agent tasks). Scheduled tasks are off unless `SCHEDULED_TASKS_ENABLED=true` and the room is listed in `SCHEDULED_TASKS_ALLOWED_ROOMS`; they are denied every mutating tool and bounded by daily/per-room ceilings.

### 12. Retention

`src/db/retention.ts` deletes terminal and stale inbox/outbox rows, sent one-off reminders, flow sessions, and old messages according to the `RETENTION_*` knobs, and clears raw provider payloads (`raw_message`, `media_path`, `mime_type`) after a fixed 7 days. It defaults to dry-run. `scripts/runRetention.ts` exposes `--apply`. Retention overlaps with AppRuntime's hourly outbox prune; deletes are idempotent.

### 13. Background tasks

`src/runtime/AppRuntime.ts` owns the process-level timers. All of them are `unref()`'d so they do not keep the process alive on their own, and are cleared on shutdown. Intervals:

- Rate-limiter prune: every 10 minutes (`RateLimiter.prune`).
- Outbox worker: every 1 second when durable storage is present (`OutboxService.claim` + delivery, concurrency 10).
- Outbox prune: every hour, removing terminal rows older than `MEDIA_RETENTION_HOURS`.
- Inbox recovery: every hour, re-claiming stranded/expired-lease rows (`InboxService.recoverStranded`). Never-claimed rows older than 24 h are failed; expired-lease `processing` rows return to `received` or are dead-lettered at the attempt limit. The inbox claim lease itself is derived from the turn budget (10–60 min).
- Flow-session TTL prune: every hour (`FlowHandler.pruneAllExpired`, 24 h local TTL).
- Media cleanup: on startup and every `MEDIA_CLEANUP_INTERVAL_MS` (default 6 h), deleting files older than `MEDIA_RETENTION_HOURS`.
- Retention maintenance: on startup and every 24 h, only when a durable messaging store is present (`src/db/retention.ts`, dry-run unless `RETENTION_DRY_RUN=false`).
- Startup parser-coverage scan: once, 5 s after boot. `src/index.ts` always passes `runStartupCoverageScan` to `AppRuntime`, which bounds it to 2,000 stored messages and treats any failure as non-fatal (a warning, never a failed boot).
- Scheduler and digest service: driven by their own `start()` loops.

`MEDIA_CLEANUP_INTERVAL_MS`, `MEDIA_RETENTION_HOURS`, and `RETENTION_*` control these. Retention overlaps with the hourly outbox prune; deletes are idempotent.

`ConfigService`, `AuthService`, `IdentityService`, `ServiceBindingService`, `EmbeddingService`, `MediaService`, `ConversationSummarizer`, and `NotificationSubscriptionService` run on demand rather than on a timer. See [docs/services.md](./services.md) for per-service configuration and lifecycle detail.

### 14. Digests

`src/utils/DigestService.ts` produces nightly per-room conversation summaries and a weekly Jellyfin "new media" rollup, fired once per day/week at `DIGEST_HOUR_UTC` with exactly-once delivery via markers in `app_kv`. A failed delivery releases its marker so the 60 s poll retries it, but only for 3 attempts per daily digest; the weekly media rollup has its own 30-attempt budget, because its marker is keyed by the previous week and giving up means waiting another week. After the budget is spent the marker is kept, which parks the digest until the next period instead of re-running a summarisation call every minute. Markers older than 30 days are pruned during the daily pass, because nothing else covers `app_kv`. On-demand digests are available in-chat via `/digest [hours]`.

### 15. Admin Dashboard

`/admin` on the same listener as webhook intake is a read-mostly operator dashboard. It requires `METRICS_AUTH_TOKEN` of at least 24 bytes; without it every `/admin` path returns `404`. Authentication exchanges the token for an `HttpOnly; SameSite=Strict` session cookie plus a CSRF token sent in `x-admin-csrf`. Routes are documented in `docs/api.md`.

### 16. Logging and Error Handling

- Logging uses Pino (`src/utils/logger.ts`). `LOG_LEVEL` controls verbosity (`trace`/`debug`/`info`/`warn`/`error`/`fatal`, default `info`). `NODE_ENV=production` emits raw JSON lines; otherwise `pino-pretty` is used. Child loggers are created per module via `logger.child({ module })`.
- Provider failures surface as `ProviderError` subclasses with a `code` (`NOT_CONFIGURED`, `START_FAILED`, `NOT_CONNECTED`, `INVALID_TARGET`, `UNSUPPORTED`, `OPERATION_FAILED`, `STALE_LIFECYCLE`, `PERMISSION_DENIED`) and a `retryable` flag.
- AI protocol failures surface as `AIProtocolError` (`invalid_response`, `no_choices`, `invalid_chunk`, `invalid_sse`, `sse_buffer_limit`, `empty_stream`, `incomplete_stream`, `empty_response`, `response_too_large`).
- Webhook request failures surface as `WebhookRequestError` with an HTTP status; the server maps them to the response status.
- Validation failures at startup throw after logging every error; the process does not start with an invalid environment.

### 17. Reaction Feedback

A thumbs up or thumbs down on a bot reply is recorded as a quality signal (`src/utils/feedback.ts`). Reactions were previously sent but incoming ones ignored. Metrics are always collected and exported on `/metrics` (`elastrax_feedback_total`, `elastrax_feedback_retracted_total`); the optional JSONL eval log (`FEEDBACK_LOG_PATH`, default `data/feedback.jsonl`) is on by default and `FEEDBACK_LOG_ENABLED=false` turns only the log off. `FEEDBACK_MAX_PER_DAY` (default 2000) caps log entries per UTC day, not the counters.
