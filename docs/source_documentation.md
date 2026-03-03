# ElastraX v7 - Source Code Documentation

## `src/index.ts`

- **Lines of code**: 249
- **Description**:
```text
*
 * @file src/index.ts
 * @description Application entry point for ElastraX v7.
 *
 * Responsibilities:
 *  1. Validate required environment variables (fail fast on misconfiguration).
 *  2. Run Drizzle ORM database migrations on startup.
 *  3. Instantiate and start all messaging platform providers (WhatsApp, Discord).
 *  4. Wire each provider's incoming-message event to the core AI agent handler.
 *  5. On graceful shutdown (SIGINT / Ctrl-C):
 *       - Dump representative WAMessage fixture files to test/fixtures/wa_messages/
 *         so the parser test suite can grow automatically over time.
 *       - Stop all providers cleanly.
 *  6. Run a lightweight parser-coverage scan 5 seconds after startup so that
 *     any message-type gaps are surfaced in the logs without blocking boot.
```

## `src/webhookServer.ts`

- **Lines of code**: 491
- **Description**:
```text
*
 * @file src/webhookServer.ts
 * @description Lightweight HTTP webhook server for inbound notifications.
 *
 * Exposes a single endpoint that external services can POST to in order to send
 * messages into any registered chat room. This turns ElastraX into a general-purpose
 * notification bus.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * CANONICAL REQUEST FORMAT (works with any HTTP client / service)
 * ═══════════════════════════════════════════════════════════════════════════════
 *   POST http://your-bot:3500/webhook
 *   Content-Type: application/json
 *
 *   {
 *     "room_id":  "120363xxxxxx@g.us",  // WhatsApp JID or Discord channel ID
 *     "text":     "Your message here",   // plain text or *bold* markdown
 *     "secret":   "your-webhook-secret"  // must match WEBHOOK_SECRET env var
 *   }
 *
 * Alternative: pass room_id and secret as query params:
 *   POST /webhook?room_id=120363xxxxxx@g.us&secret=xxx
 *   { "text": "message here" }
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * AUTO-DETECTED SERVICE ADAPTERS
 * ═══════════════════════════════════════════════════════════════════════════════
 * GitHub Actions / GitHub Webhooks (`X-GitHub-Event` header):
 *   Formats push, pull_request, issues, release, workflow_run events.
 *
 * Grafana Alerts (`X-Grafana-Origin: alertmanager` header):
 *   Formats firing / resolved alert messages.
 *
 * Generic JSON:
 *   Falls back to JSON.stringify of the body if no "text" field is found.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ENVIRONMENT VARIABLES
 * ═══════════════════════════════════════════════════════════════════════════════
 *   WEBHOOK_PORT    — Port to listen on (default: 3500)
 *   WEBHOOK_SECRET  — Shared secret for all webhook requests (required)
 *   WEBHOOK_ENABLED — Set to "false" to disable the webhook server (default: true)
```

## `src/config/env.ts`

- **Lines of code**: 105
- **Description**:
```text
*
 * @file src/config/env.ts
 * @description Startup environment validation for ElastraX.
 *
 * `validateEnv()` is called once at the very beginning of `main()` in `src/index.ts`.
 * It checks that all required environment variables are present and well-formed before
 * any providers or database connections are initialised.  If validation fails the
 * function throws, causing the process to exit with an error log — preventing a
 * partially-started bot that silently cannot talk to the LLM.
 *
 * Required variables:
 *   - AI_API_KEY       — Bearer token for the LLM provider.
 *   - AI_MODEL_NAME    — Full model identifier (e.g., "meta-llama/Meta-Llama-3-8B-Instruct").
 *   - AI_API_BASE_URL  — OpenAI-compatible base URL (must be a valid URL).
```

## `src/providers/whatsapp.ts`

- **Lines of code**: 604
- **Description**:
```text
*
 * @file src/providers/whatsapp.ts
 * @description WhatsApp messaging provider for ElastraX, built on top of the
 *              Baileys library (@whiskeysockets/baileys).
 *
 * Responsibilities:
 *  - Manage the WhatsApp WebSocket connection lifecycle (connect, auto-reconnect, disconnect).
 *  - Display a QR code in the terminal on first run so the user can link their phone.
 *  - Persist Baileys authentication credentials to the SQLite `wa_auth_state` table via
 *    `useDBAuthState` — no file-system sessions folder required.
 *  - Sync historical messages sent before the bot started into the database.
 *  - For each incoming `notify` message, parse the raw Baileys WAMessage into a
 *    normalised `MessageContext` and forward it to the registered message handler.
 *  - Handle WhatsApp V7 LID (Linked ID) sessions where participant JIDs are in
 *    "@lid" format rather than the classic phone-number "@s.whatsapp.net" format.
 *  - Download and cache attached media to `./data/media/` asynchronously so
 *    tools can access the file without hitting the CDN again.
 *
 * Key concepts:
 *  - `botLid` — The bot's own LID JID, resolved once after connection.  Used to
 *    correctly mark quoted messages as "from the bot" in LID sessions.
 *  - `mediaReady` — A Promise exposed on every `MessageContext` that resolves once
 *    background media download is complete; tools `await ctx.mediaReady` before reading
 *    `ctx.mediaPath`.
```

## `src/providers/BotProvider.ts`

- **Lines of code**: 45
- **Description**:
```text
*
 * @file src/providers/BotProvider.ts
 * @description Abstract interface that every messaging-platform provider must implement.
 *
 * ElastraX is platform-agnostic by design: the `BotProvider` interface decouples the
 * core AI agent from the specifics of any particular messaging API (WhatsApp, Discord, …).
 *
 * To add a new platform:
 *  1. Create a class that implements `BotProvider`.
 *  2. Inside `start()`, connect to the platform and, for every incoming user message,
 *     construct a `MessageContext` and call the registered `messageHandler`.
 *  3. Instantiate the provider in `src/index.ts` and call `onMessage(handleIncomingMessage)`.
```

## `src/providers/discord.ts`

- **Lines of code**: 334
- **Description**:
```text
*
 * @file src/providers/discord.ts
 * @description Discord messaging provider for ElastraX, built on top of discord.js.
 *
 * Responsibilities:
 *  - Initialise the Discord.js `Client` with the required Gateway intents (guild messages,
 *    DMs, message content) and log in using `DISCORD_BOT_TOKEN` from the environment.
 *  - Skip startup gracefully when the token is absent or set to the placeholder value
 *    `dummy_token_here` (so WhatsApp-only deployments work without a Discord token).
 *  - For every `messageCreate` event (excluding bot messages), build a normalised
 *    `MessageContext` and forward it to the registered message handler.
 *  - Download and cache Discord attachment media synchronously during context creation
 *    (Discord CDN links are stable, unlike WhatsApp's time-limited URLs).
 *  - Implement platform-specific action methods: `reply`, `react`, `sendMedia`,
 *    `sendSticker`, `deleteMessage`, `updateGroupParticipants`, `checkPermissions`.
 *
 * Notes:
 *  - `mediaReady` resolves immediately for Discord because downloads are synchronous
 *    inside `createContext` (no background-download pattern needed).
 *  - Group admin operations map WhatsApp semantics ("remove") to Discord guild kicks.
 *    Adding members requires OAuth2 and is intentionally unsupported.
```

## `src/providers/whatsappParser.ts`

- **Lines of code**: 292
- **Description**:
```text
*
 * @file src/providers/whatsappParser.ts
 * @description Pure, side-effect-free parser for raw Baileys WAMessage objects.
 *
 * The parser is intentionally decoupled from the socket, database, and any I/O so
 * that it can be unit-tested directly with fixture JSON files stored in
 * `test/fixtures/wa_messages/`.
 *
 * Key exported symbols:
 *  - `ParsedWAMessage`      — Normalised view of a WAMessage (type, text, media flag, etc.)
 *  - `ParsedQuotedMessage`  — Normalised view of the quoted/replied-to message.
 *  - `LidResolver`          — Async function type used to map PN JIDs → LID JIDs.
 *  - `parseWhatsAppMessage` — Main parser entry point; handles all known WA message types.
 *  - `getFileLength`        — Extracts the `fileLength` field from a message for size checks.
 *  - `normalizeJid`         — Strips domain and device suffixes from a JID for comparison.
 *
 * Supported message types (unwrapped automatically):
 *  conversation, extendedTextMessage, imageMessage, videoMessage, audioMessage,
 *  documentMessage, stickerMessage, viewOnceMessage, viewOnceMessageV2,
 *  viewOnceMessageV2Extension, documentWithCaptionMessage, listResponseMessage,
 *  buttonsResponseMessage, productMessage, and unknown fallback.
```

## `src/agent/index.ts`

- **Lines of code**: 894
- **Description**:
```text
*
 * @file src/agent/index.ts
 * @description Core conversational agent for ElastraX.
 *
 * This module exports `handleIncomingMessage`, which is the single entry point
 * wired to every messaging platform provider (WhatsApp, Discord, etc.).
 *
 * High-level processing pipeline for each incoming message:
 *  1. Fetch or create the ChatRoom record in the database; resolve per-room config.
 *  2. Determine whether the AI should generate a reply (`shouldTriggerAI`).
 *     - Private chats: always reply.
 *     - Group chats: reply only when the bot is mentioned, replied-to, or
 *       `autoReplyAll` is enabled, or the message starts with `/chat`.
 *  3. Intercept active interactive flows (multi-step wizards) via FlowHandler.
 *  4. Handle explicit slash commands (e.g., `/search <query>`) by routing them
 *     directly to the matching BaseTool — no LLM involved.
 *  5. For conversational messages, save the user message to the database,
 *     await media downloads, build the full context window, and run the
 *     LLM inference loop (which may invoke tools recursively, with streaming
 *     support when enabled).
 *  6. Persist the final assistant reply and send it back to the user.
 *
 * V7.10 additions:
 *  - Typed LLM interfaces (ChatCompletionMessage, ToolCall)
 *  - Streaming responses with rate-limited message editing
 *  - Conversation branching (smart quoted-message context loading)
 *  - Health metrics integration
 *  - Typing indicators
```

## `src/utils/resolveTargetUser.ts`

- **Lines of code**: 171
- **Description**:
```text
*
 * @file src/utils/resolveTargetUser.ts
 * @description Unified user-identity resolver for any tool or command that
 *              needs to target a specific user.
 *
 * Supports 4 input sources (tried in priority order):
 *  1. **@mention**     — The first mentioned JID in the message.
 *  2. **quoted reply** — The sender of the message being replied to.
 *  3. **explicit arg** — A phone number, LID, or full JID typed directly.
 *  4. **sentinel**     — The LLM can output `"mentioned"` or `"quoted"` to
 *                        explicitly pick source 1 or 2.
 *
 * The resolved result includes the full JID (usable with Baileys APIs),
 * a human-friendly display string, and the source used.
 *
 * This module is designed to be the *single* place where user-targeting
 * logic lives.  Tools should never roll their own phone-number → JID
 * normalisation — use `resolveTargetUser()` instead.
 *
 * @example
 *   // Inside a tool's execute():
 *   const target = resolveTargetUser(args, ctx, 'user');
 *   if (!target) return t(lang, 'common.no_target_user');
 *   await ctx.updateGroupParticipants('remove', [target.jid]);
```

## `src/utils/ModelRouter.ts`

- **Lines of code**: 376
- **Description**:
```text
*
 * @file src/utils/ModelRouter.ts
 * @description Multi-provider LLM router with automatic failover.
 *
 * Tries AI providers in priority order, falling back to the next one if a
 * request fails. This ensures high availability and allows you to mix providers
 * (e.g., Modal for speed, Gemini as backup, local Ollama as last resort).
 *
 * Configuration — set AI_PROVIDERS to a comma-separated priority list:
 *   AI_PROVIDERS=modal,gemini,ollama        (default: just uses the legacy AI_API_BASE_URL setup)
 *
 * Per-provider environment variables (replace {NAME} with the provider name in uppercase):
 *   AI_{NAME}_BASE_URL        — OpenAI-compatible endpoint (required per provider)
 *   AI_{NAME}_API_KEY         — Bearer token (optional, defaults to 'dummy')
 *   AI_{NAME}_MODEL           — Model identifier
 *   AI_{NAME}_SUPPORTS_VIDEO  — 'true' if the model/provider accepts video_url content blocks
 *   AI_{NAME}_SUPPORTS_AUDIO  — 'true' if the model/provider accepts audio_url content blocks
 *
 * Well-known provider auto-defaults (can be overridden via env):
 *   modal      — supportsVideo: true,  supportsAudio: true  (vLLM / Qwen3-Omni)
 *   gemini     — supportsVideo: false, supportsAudio: false (inline base64 not supported via OAI compat)
 *   openrouter — supportsVideo: false, supportsAudio: false
 *   groq       — supportsVideo: false, supportsAudio: false
 *   cloudflare — supportsVideo: false, supportsAudio: false
 *   pollinations— supportsVideo: false, supportsAudio: false
 *   airforce   — supportsVideo: false, supportsAudio: false
 *
 * Example .env block:
 *   AI_PROVIDERS=modal1,pollinations,airforce,cloudflare,openrouter,groq,gemini
 *   AI_MODAL1_BASE_URL=https://your-modal-endpoint.modal.run/v1
 *   AI_MODAL1_API_KEY=dummy
 *   AI_MODAL1_MODEL=cyankiwi/Qwen3-Omni-30B-A3B-Instruct-AWQ-4bit
 *   AI_MODAL1_SUPPORTS_VIDEO=true
 *   AI_MODAL1_SUPPORTS_AUDIO=true
 *
 * If AI_PROVIDERS is not set, it falls back to the legacy single-provider setup
 * (AI_API_BASE_URL / AI_API_KEY / AI_MODEL_NAME).
```

## `src/utils/syncHistoricalDatabase.ts`

- **Lines of code**: 87
- **Description**:
```text
*
 * @file src/utils/syncHistoricalDatabase.ts
 * @description Bulk ingestion of Baileys history-sync messages into the ElastraX database.
 *
 * When a new WhatsApp session is established (or when Baileys reconnects), WhatsApp
 * may push a `messaging-history.set` event containing messages that were sent/received
 * before the bot's current session started.  This module persists those historical
 * messages so that the LLM context window contains real prior conversation history
 * rather than starting blank.
 *
 * Design principles:
 *  - **Idempotent**: uses `onConflictDoNothing()` keyed on `providerMessageId` so
 *    running the sync multiple times on the same data is safe.
 *  - **Non-blocking**: called via `.catch()` in the provider so failures here
 *    never crash the main bot process.
 *  - **Media-light**: historical messages are stored without downloading their
 *    media attachments to avoid hammering the WhatsApp CDN at startup.
```

## `src/utils/permissions.ts`

- **Lines of code**: 148
- **Description**:
```text
*
 * @file src/utils/permissions.ts
 * @description WhatsApp-specific permission & role resolution for slash commands.
 *
 * V7.11 set-based role model:
 *
 *  | Role      | Scope    | Source                                                |
 *  |-----------|----------|-------------------------------------------------------|
 *  | `user`    | global   | Implicit — every user.                                |
 *  | `premium` | global   | DB-granted.                                           |
 *  | `admin`   | per-room | DB-granted OR WA group admin/superadmin.              |
 *  | `owner`   | global   | BOT_OWNER_JID env OR DB-granted.                      |
 *
 * Exported helpers:
 *  - `resolveUserRoles(sock, chatId, senderId, isGroup)` — full role set.
 *  - `checkPermissions(sock, chatId, senderId, isGroup, required)` — boolean check.
 *  - `isWhatsAppGroupAdmin(sock, chatId, senderId)` — platform-native check.
 *
 * Configuration:
 *  - `BOT_OWNER_JID` — Full WhatsApp JID of the bot owner.
```

## `src/utils/logger.ts`

- **Lines of code**: 40
- **Description**:
```text
*
 * @file src/utils/logger.ts
 * @description Shared structured logger instance for the entire ElastraX application.
 *
 * Built on [Pino](https://getpino.io/), a low-overhead JSON logger, with the
 * `pino-pretty` transport for human-readable, colourised output during development.
 *
 * Log level:
 *  Controlled by the `LOG_LEVEL` environment variable.  Valid values are:
 *  `trace`, `debug`, `info` (default), `warn`, `error`, `fatal`.
 *
 * Usage:
 * ```ts
 * import { logger } from './utils/logger';
 *
 * logger.info('Server started');
 * logger.warn({ userId }, 'Session expired');
 * logger.error(err, 'Unexpected failure');
 * ```
 *
 * In production you may want to swap the transport for structured JSON output by
 * removing the `transport` block so logs can be ingested by tools like Datadog or Loki.
```

## `src/utils/FFmpegConverter.ts`

- **Lines of code**: 99
- **Description**:
```text
*
 * @file src/utils/FFmpegConverter.ts
 * @description Low-level buffer-to-buffer FFmpeg wrapper used by `StickerUtils`.
 *
 * Spawns an FFmpeg child process with caller-supplied arguments to convert an
 * input buffer (written to a temporary file) into an output buffer (read back
 * from a temporary file).  Temporary files are cleaned up regardless of success
 * or failure.
 *
 * Prerequisites:
 *  - `ffmpeg` must be available on the system `PATH`.  Install via your OS package
 *    manager (e.g., `apt install ffmpeg`, `brew install ffmpeg`) or the Dockerfile.
 *
 * Security:
 *  - File extensions are validated against a strict alphanumeric allowlist before
 *    being interpolated into the file path to prevent path-traversal attacks.
```

## `src/utils/ParameterValidator.ts`

- **Lines of code**: 111
- **Description**:
```text
*
 * @file src/utils/ParameterValidator.ts
 * @description Parses and validates raw slash-command argument strings into typed
 *              JSON payloads that match a tool's OpenAI JSON Schema definition.
 *
 * When a user types `/search cats and dogs`, the slash-command router extracts
 * `"cats and dogs"` and calls `ParameterValidator.parseArgs(tool, "cats and dogs")`.
 * The validator maps the raw string onto the tool's declared parameters using
 * simple heuristics:
 *
 *  - **Single string parameter** — the entire argument string is used verbatim
 *    (preserves natural language phrasing like search queries).
 *  - **Multiple parameters** — the string is split respecting quoted sub-strings
 *    (e.g., `add "John Doe" admin` → `['John Doe', 'admin']`).
 *  - **Type coercion** — numeric and boolean fields are cast from the raw string.
 *  - **Required field validation** — throws a user-friendly usage-help message
 *    if a required parameter is missing.
```

## `src/utils/SessionManager.ts`

- **Lines of code**: 202
- **Description**:
```text
*
 * @file src/utils/SessionManager.ts
 * @description Persistent session store for multi-step interactive flows.
 *
 * When a tool needs to collect information across several user messages (a "wizard"),
 * it uses `SessionManager` to persist step data between message events.  The agent's
 * `FlowHandler` checks for an active session before routing messages to the LLM.
 *
 * Session keying:
 *  Sessions are keyed by `"${platform}:${userId}"` to prevent cross-platform
 *  collisions when the same user interacts via both WhatsApp and Discord.
 *
 * Persistence:
 *  Sessions are stored in both an in-memory `Map` (for fast reads) and the
 *  `flow_sessions` SQLite table (for crash recovery). Every `set()` and `clear()`
 *  operation writes through to both stores.
 *
 * Expiry:
 *  Each flow has a configurable TTL (default 300 seconds / 5 minutes).  Expired
 *  flows are pruned lazily when `get()` is called.
```

## `src/utils/RateLimiter.ts`

- **Lines of code**: 123
- **Description**:
```text
*
 * @file src/utils/RateLimiter.ts
 * @description Token-bucket rate limiter for per-user message throttling.
 *
 * Prevents a single user from flooding the LLM endpoint or tools.
 * Each user gets a bucket with a configurable capacity of tokens.  Tokens are
 * consumed on each message and refill at a constant rate over time.
 *
 * V7.11: Supports **per-role variable limits** via `checkWithLimits()`.
 * The legacy `check()` method still works using the global env defaults.
 *
 * Configuration via environment variables (global fallback):
 *  - RATE_LIMIT_MESSAGES  : Max messages per window (default: 10)
 *  - RATE_LIMIT_WINDOW_SEC: Refill window in seconds (default: 60)
 *
 * Per-role overrides are controlled by `PrivilegeService` and passed to
 * `checkWithLimits()` at call-time.
```

## `src/utils/HealthMetrics.ts`

- **Lines of code**: 331
- **Description**:
```text
*
 * @file src/utils/HealthMetrics.ts
 * @description In-memory health metrics collector for ElastraX monitoring.
 *
 * Tracks key operational metrics:
 *  - Message throughput (received, processed, errors)
 *  - LLM latency percentiles (P50, P95, P99)
 *  - Provider success/failure counts
 *  - Active rooms and queue depth
 *  - Tool invocation counts
 *
 * Exposes:
 *  - `getMetrics()` — JSON snapshot for the /health endpoint
 *  - `getPrometheusMetrics()` — Prometheus-compatible text exposition
 *
 * Usage:
 * ```ts
 * import { healthMetrics } from './HealthMetrics';
 * healthMetrics.recordMessageReceived();
 * healthMetrics.recordLLMRequest('modal', 250, true);
 * ```
```

## `src/utils/MediaCleanup.ts`

- **Lines of code**: 41

## `src/utils/RoleService.ts`

- **Lines of code**: 312
- **Description**:
```text
*
 * @file src/utils/RoleService.ts
 * @description Service for managing user roles/permissions in the bot.
 *
 * V7.11 Role Model — set-based (a user can hold multiple roles simultaneously):
 *
 *  | Role      | Scope    | Source                                          |
 *  |-----------|----------|-------------------------------------------------|
 *  | `user`    | global   | Implicit — every user has this role.             |
 *  | `premium` | global   | Explicitly granted in DB.                       |
 *  | `admin`   | per-room | DB grant OR platform-native (WA/Discord admin). |
 *  | `owner`   | global   | BOT_OWNER_JID env var OR DB grant.              |
 *
 * "premium" and "admin" are **parallel** (same weight, mutually exclusive tool access).
 * Only "owner" subsumes both — an owner can use any tool.
 *
 * Roles can be scoped:
 *  - `global`   — Applies everywhere (all groups + DMs).
 *  - `<chatId>` — Applies only within the specific group/chat.
 *
 * When resolving the full role set the lookup order is:
 *  1. Everyone starts with `user`.
 *  2. Env-based owner check (BOT_OWNER_JID) → adds `owner`.
 *  3. DB roles (global + chat-scoped) → adds each stored role.
 *  4. Platform-native admin (if `isPlatformAdmin` flag is set) → adds `admin`.
```

## `src/utils/i18n.ts`

- **Lines of code**: 378
- **Description**:
```text
*
 * @file src/utils/i18n.ts
 * @description Lightweight internationalisation (i18n) helper for ElastraX.
 *
 * Provides a single `t()` function that resolves a dot-separated translation key
 * to a localised string, with optional `{variable}` interpolation.
 *
 * Supported locales:
 *  - `en` — English (default)
 *  - `id` — Indonesian (Bahasa Indonesia)
 *
 * Adding a new locale:
 *  1. Add an entry to the `Locale` type union.
 *  2. Duplicate the `en` block in `translations` with the new locale key.
 *  3. Translate each string value.
 *
 * Adding a new translation key:
 *  1. Add the key/value to both `en` and `id` blocks.
 *  2. Call `t(lang, 'your.new.key')` in the appropriate module.
 *
 * Fallback behaviour:
 *  If the key does not exist in the requested locale, the `en` value is used.
 *  If the key does not exist in `en` either, a warning is logged and the raw key
 *  string is returned so UI output is still legible.
```

## `src/utils/similarity.ts`

- **Lines of code**: 67
- **Description**:
```text
*
 * @file src/utils/similarity.ts
 * @description Utility for calculating string similarity using Levenshtein distance.
```

## `src/utils/MessageQueue.ts`

- **Lines of code**: 115
- **Description**:
```text
*
 * @file src/utils/MessageQueue.ts
 * @description Per-room asynchronous message queue with concurrency control.
 *
 * Prevents the bot from being overwhelmed when multiple messages arrive
 * simultaneously in a busy group chat. Each room gets its own queue with
 * configurable concurrency (default: 1 — process one message at a time per room).
 *
 * Messages are processed in FIFO order within each room. Idle queues are
 * automatically pruned to prevent unbounded memory growth.
 *
 * Usage:
 * ```ts
 * const queue = new MessageQueue(1);
 * queue.enqueue(chatId, () => handleIncomingMessage(ctx));
 * ```
```

## `src/utils/IdentityService.ts`

- **Lines of code**: 206
- **Description**:
```text
*
 * @file src/utils/IdentityService.ts
 * @description Persistent LID ↔ PN identity mapping for Baileys V7.
 *
 * Baileys V7 uses "LID" JIDs (Linked IDs) as the primary identifier for
 * WhatsApp users.  Phone-number JIDs (`@s.whatsapp.net`) are a secondary
 * fallback and are NOT always available — especially in group contexts.
 *
 * This service maintains a `user_identities` table that maps LID ↔ PN so
 * that:
 *  - `RoleService` can look up all JIDs for a user when checking DB roles.
 *  - `/role check` can display the correct identity regardless of JID format.
 *  - `BOT_OWNER_JID` (a PN) can be matched against a LID-based senderId.
 *
 * The mapping is populated:
 *  - On every incoming message (upsert with latest pushName).
 *  - At startup for the bot owner (seeded from `BOT_OWNER_JID` env var).
```

## `src/utils/PrivilegeService.ts`

- **Lines of code**: 201
- **Description**:
```text
*
 * @file src/utils/PrivilegeService.ts
 * @description Per-role privilege / quota system for ElastraX.
 *
 * Each role has a set of numeric quotas (rate limits, context size, etc.).
 * Default values come from environment variables; per-role overrides can be
 * stored in the `role_privileges` DB table.
 *
 * When a user holds multiple roles, the **most permissive** value for each
 * quota wins (i.e., the highest number, or -1 for unlimited).
 *
 * Environment variable naming convention:
 *   ROLE_PRIV_{ROLE}_{FIELD}
 *
 * Example:
 *   ROLE_PRIV_PREMIUM_MESSAGES_PER_WINDOW=30
 *   ROLE_PRIV_OWNER_CONTEXT_LIMIT=100
 *
 * If the env var is unset, a sensible hardcoded default is used.
```

## `src/utils/ConversationSummarizer.ts`

- **Lines of code**: 94
- **Description**:
```text
*
 * @file src/utils/ConversationSummarizer.ts
 * @description Compresses old conversation history into a rolling summary.
 *
 * When a chat room's message history exceeds the configured context limit,
 * instead of blindly dropping the oldest messages (losing important context),
 * the summarizer:
 *   1. Takes the oldest 50% of messages that fall outside the active window.
 *   2. Calls the LLM to compress them into a concise, factual summary paragraph.
 *   3. Injects the summary as a special system-level message at the top of the
 *      history so the bot "remembers" earlier parts of the conversation.
 *   4. Stores the summary in the `chat_rooms` table's `summaryCache` column
 *      (if present) to avoid re-summarizing on every request.
 *
 * This gives the bot effective long-term memory without burning tokens on
 * the full history.
```

## `src/utils/ConfigService.ts`

- **Lines of code**: 50
- **Description**:
```text
*
 * @file src/utils/ConfigService.ts
 * @description Merges global defaults with per-room database overrides to produce a
 *              fully resolved runtime configuration for a chat room.
 *
 * Resolution priority (highest to lowest):
 *  1. Per-room value stored in the `chat_rooms` table (set via `/config set …`).
 *  2. Environment variable (AI_TEMPERATURE, CONTEXT_MESSAGE_LIMIT, etc.).
 *  3. Hardcoded default constant (e.g., DEFAULT_SYSTEM_PROMPT, temperature = 0.7).
 *
 * Having all config resolution in one place ensures that the agent, tools, and any
 * future modules consistently observe the same effective settings for a room.
```

## `src/utils/parserCoverage.ts`

- **Lines of code**: 111
- **Description**:
```text
*
 * parserCoverage.ts
 *
 * Scans a list of raw WAMessage JSON strings from the database and runs each
 * through `parseWhatsAppMessage()`, reporting:
 *  - OK messages grouped by messageType
 *  - Errors (parser threw) with the raw message attached
 *  - Messages that parsed as 'unknown' (unrecognised structure)
 *
 * This module has NO side effects — it is pure scanning logic. Both the bot
 * startup check and the SIGINT fixture dumper import from here.
```

## `src/utils/StickerUtils.ts`

- **Lines of code**: 82
- **Description**:
```text
*
 * @file src/utils/StickerUtils.ts
 * @description High-level sticker conversion utilities used by `MakeStickerTool`.
 *
 * Wraps `FFmpegConverter` to produce WhatsApp-compatible WebP sticker buffers from
 * still images and short videos/GIFs.  Also handles writing the EXIF metadata block
 * that WhatsApp requires to recognise a WebP file as a sticker (pack name, author).
 *
 * FFmpeg filter used for both images and videos:
 *  - Scales the input down to at most 320×320 pixels (preserving aspect ratio).
 *  - Pads to exactly 320×320 with a transparent background.
 *  - For videos: caps at 15 fps and truncates to the first 5 seconds (WA sticker limit).
 *  - Converts to a palette-based WebP with transparency support.
 *
 * Prerequisites: `ffmpeg` binary must be available on the system PATH.
```

## `src/utils/MediaStorage.ts`

- **Lines of code**: 52
- **Description**:
```text
*
 * @file src/utils/MediaStorage.ts
 * @description Shared utility for saving media buffers to the local filesystem.
 *
 * Both WhatsApp and Discord providers need to persist downloaded media to
 * `./data/media/` with a unique filename. This module extracts that shared
 * logic to avoid duplication and ensure consistent behavior across providers.
```

## `src/utils/useDBAuthState.ts`

- **Lines of code**: 135
- **Description**:
```text
*
 * @file src/utils/useDBAuthState.ts
 * @description SQLite-backed Baileys authentication state adapter.
 *
 * Baileys (the WhatsApp library) requires a persistent key-value store for:
 *  - `creds` — The device registration credentials (analogous to a login session).
 *  - Signal Protocol session keys — Keyed as `"${category}-${id}"` (e.g.,
 *    `"app-state-sync-key-XYZ"`, `"session-628xxx"`, etc.).
 *
 * The default Baileys adapter writes these to JSON files on disk.  This adapter
 * stores them in the `wa_auth_state` SQLite table instead, so:
 *  - No extra volume mount is needed in Docker for `/auth_info_baileys/`.
 *  - Credentials and session keys survive container restarts automatically.
 *  - Everything stays in the single `bot.db` file that is already being backed up.
 *
 * Serialisation note:
 *  Baileys auth data contains `Buffer` objects that must be serialised with
 *  `BufferJSON.replacer` and deserialised with `BufferJSON.reviver`.  Standard
 *  `JSON.stringify/parse` silently corrupts Buffers into plain objects, causing
 *  "No session to decrypt" errors.  This adapter handles that correctly.
```

## `src/utils/Scheduler.ts`

- **Lines of code**: 168
- **Description**:
```text
*
 * @file src/utils/Scheduler.ts
 * @description Background task scheduler for persistent reminders.
 *
 * Polls the `reminders` database table every minute and fires any reminders
 * whose `remind_at` timestamp has passed. Fired reminders are marked as sent
 * so they are never delivered twice, even across restarts.
 *
 * The scheduler requires a `sendCallback` to be registered by the provider layer
 * so it can send messages back to the chat room. Multiple providers can register
 * callbacks; the scheduler picks the one matching the reminder's platform.
 *
 * Usage (in src/index.ts after providers start):
 * ```ts
 * Scheduler.registerSender('whatsapp', (chatId, text) => waProvider.sendMessage(chatId, text));
 * Scheduler.start();
 * ```
```

## `src/types/ai.ts`

- **Lines of code**: 117
- **Description**:
```text
*
 * @file src/types/ai.ts
 * @description Typed interfaces for OpenAI-compatible LLM API requests and responses.
 *
 * These types replace the `any` types previously used throughout the codebase
 * for LLM chat completion requests and responses. They cover:
 *  - Standard (non-streaming) chat completion responses
 *  - Streaming (SSE) chat completion chunks
 *  - Tool/function calling structures
 *  - Token usage statistics
 *
 * All types follow the OpenAI API specification and are compatible with any
 * OpenAI-compatible endpoint (Gemini, Ollama, Modal, Cloudflare Workers AI, etc.).
```

## `src/types/node-webpmux.d.ts`

- **Lines of code**: 8

## `src/db/index.ts`

- **Lines of code**: 39
- **Description**:
```text
*
 * @file src/db/index.ts
 * @description Initialises and exports the shared Drizzle ORM database instance.
 *
 * The database file is stored at `./data/bot.db` relative to the working directory.
 * The `data/` directory is created automatically if it does not yet exist so that
 * first-run setup requires no manual steps.
 *
 * SQLite pragmas applied at open time:
 *  - `journal_mode = WAL` — Write-Ahead Logging allows concurrent reads during writes,
 *    which is important because providers and the agent may access the DB simultaneously.
 *  - `synchronous = NORMAL` — Balances durability against write throughput; safe for
 *    a bot workload where losing the very last message on a crash is acceptable.
 *
 * The exported `db` object should be imported directly by all modules that need
 * database access — no connection pool or factory is required for SQLite.
```

## `src/db/schema.ts`

- **Lines of code**: 166
- **Description**:
```text
*
 * @file src/db/schema.ts
 * @description Drizzle ORM table definitions for the ElastraX SQLite database.
 *
 * Tables:
 *  - `chat_rooms`   — One row per unique chat/group across all platforms.
 *                     Stores per-room configuration overrides (V7.5+).
 *  - `messages`     — Append-only log of every user and assistant message.
 *                     Serves as the conversation history window sent to the LLM.
 *  - `wa_auth_state`— Key-value store for Baileys WhatsApp authentication credentials.
 *                     Replaces the file-system auth_info_baileys/ folder so credentials
 *                     survive container restarts without a mounted volume.
 *
 * Migration files live in `drizzle/migrations/` and are applied automatically on startup
 * via `drizzle-kit` in `src/index.ts`.
```

## `src/ai/client.ts`

- **Lines of code**: 263
- **Description**:
```text
*
 * @file src/ai/client.ts
 * @description OpenAI-compatible AI client used by the ElastraX agent.
 *
 * This module provides:
 *  - `AIChatMessage` — the canonical multi-modal chat message shape sent to the LLM.
 *  - `AIClientConfig` — optional constructor overrides for the base URL, API key, and model.
 *  - `AIClient` — a thin HTTP wrapper around any OpenAI-compatible `/chat/completions`
 *    endpoint (e.g., a self-hosted Llama instance via Modal, or Google Gemini via its
 *    OpenAI-compatible gateway at https://generativelanguage.googleapis.com/v1beta/openai/).
 *
 * Configuration (resolved in priority order):
 *   1. Constructor `config` argument
 *   2. Environment variables: AI_API_BASE_URL, AI_API_KEY, AI_MODEL_NAME
 *   3. Hardcoded defaults (Meta-Llama-3-8B-Instruct)
```

## `src/core/FlowHandler.ts`

- **Lines of code**: 95
- **Description**:
```text
*
 * @file src/core/FlowHandler.ts
 * @description Multi-step interactive flow dispatcher for ElastraX.
 *
 * Some tools (e.g., multi-step wizards) need to hold state across several user
 * messages.  `FlowHandler` bridges the gap between the stateless agent loop and
 * those stateful interactions by:
 *
 *  1. Letting tools register a named `FlowProcessor` callback via `FlowHandler.register()`.
 *  2. Intercepting every incoming message and checking `SessionManager` to see whether
 *     the sender is currently inside an active flow.
 *  3. Routing the message to the appropriate registered processor, or cancelling the
 *     flow if the user types a recognised cancel command (e.g., `/cancel`, `/batal`).
 *
 * Usage example (inside a tool's `execute` method):
 * ```ts
 * FlowHandler.register('my_flow', async (ctx, data, flowId) => {
 *   // Handle the next step of the wizard
 * });
 * SessionManager.set(ctx.senderId, 'my_flow', { flow: 'my_flow', step: 'step1', data: {} }, ctx.platform);
 * ```
```

## `src/core/MessageContext.ts`

- **Lines of code**: 214

## `src/core/constants.ts`

- **Lines of code**: 15
- **Description**:
```text
*
 * @file src/core/constants.ts
 * @description Shared constants used across the ElastraX core pipeline.
 *
 * Centralising constants here ensures that command names and other shared
 * values can be changed in one place without hunting through multiple files.
```

## `src/core/prompts.ts`

- **Lines of code**: 31
- **Description**:
```text
*
 * @file src/core/prompts.ts
 * @description Default system prompt(s) for the ElastraX LLM agent.
 *
 * The system prompt is injected as the first message in every LLM request to
 * shape the model's persona, capabilities, and localisation behaviour.
 *
 * Per-room overrides:
 *   Admins can replace `DEFAULT_SYSTEM_PROMPT` on a per-chat-room basis via the
 *   `/config set systemPrompt <text>` command.  `ConfigService.getResolvedConfig()`
 *   will use the DB value when present, otherwise it falls back to this constant
 *   (or the value of the `DEFAULT_SYSTEM_PROMPT` environment variable if set).
 *
 * Template variables:
 *   - `{{LANGUAGE}}` — Replaced at runtime with the full language name
 *     (e.g., "English" or "Indonesian (Bahasa Indonesia)") so the AI responds
 *     in the correct language for the active chat room.
```

## `src/tools/DownloadTool.ts`

- **Lines of code**: 219
- **Description**:
```text
*
 * @file src/tools/DownloadTool.ts
 * @description Media downloader powered by yt-dlp.
 *
 * Downloads audio or video from URLs supported by yt-dlp (YouTube, Instagram,
 * TikTok, Twitter/X, SoundCloud, Vimeo, and 1000+ other sites) and sends the
 * result back to the chat.
 *
 * Configuration:
 *   YTDLP_PATH      — Path to the yt-dlp binary (default: 'yt-dlp' from PATH).
 *   DOWNLOAD_MAX_MB — Maximum file size to send (default: 50 MB).
 *
 * Works conversationally ("download this YouTube video as mp3": AI calls this tool)
 * and via slash command: /download [format] [url]
 *
 * Slash command aliases: /download, /dl
```

## `src/tools/TranslateTool.ts`

- **Lines of code**: 161
- **Description**:
```text
*
 * @file src/tools/TranslateTool.ts
 * @description Language translation tool powered by the configured LLM.
 *
 * Translates text using the same LLM already powering the bot — no extra API
 * key or dependency needed. The LLM is instructed to return only the translated
 * text, nothing else.
 *
 * If the user replies to a message, the quoted message body is used as the
 * source text (allowing translate-by-reply). If text is directly provided,
 * that takes priority.
 *
 * Works conversationally ("translate this to Spanish") and via slash command:
 *   /translate [target_lang] [optional: text]  — or reply to a message.
 *
 * Slash command aliases: /translate, /tr
```

## `src/tools/MenuTool.ts`

- **Lines of code**: 145
- **Description**:
```text
*
 * @file src/tools/MenuTool.ts
 * @description Interactive help menu tool for ElastraX.
 *
 * Generates a formatted list of all available slash commands (grouped by category)
 * when invoked with no arguments, or detailed usage information for a specific command
 * when a `command_name` argument is provided.
 *
 * The tool receives a `ToolGetter` function at construction time (instead of importing
 * the `tools` array directly) to avoid circular dependencies between `index.ts` and
 * the individual tool files.
 *
 * Slash command aliases: `/help`, `/h`, `/?`
```

## `src/tools/WebSearchTool.ts`

- **Lines of code**: 107
- **Description**:
```text
*
 * @file src/tools/WebSearchTool.ts
 * @description Web search tool powered by a self-hosted SearXNG instance.
 *
 * When the LLM determines that a user question requires up-to-date or factual
 * information it calls this tool with a search query.  The tool queries the
 * configured SearXNG instance (default: `SEARXNG_URL` env var), retrieves the
 * top-5 results, and returns a structured text snippet that the LLM can
 * summarise for the user.
 *
 * Configuration:
 *  - `SEARXNG_URL` — Base URL of the SearXNG instance (e.g., https://searx.example.com).
 *    Falls back to the bundled private instance if not set.
 *
 * Slash command aliases: `/search`, `/google`, `/duckduckgo`
```

## `src/tools/BaseTool.ts`

- **Lines of code**: 122
- **Description**:
```text
*
 * @file src/tools/BaseTool.ts
 * @description Abstract base class and shared type definitions for all ElastraX tools.
 *
 * Every tool in `src/tools/` must extend `BaseTool` and implement its abstract members.
 * This ensures a consistent shape that is consumed by:
 *  - The **LLM function-calling** layer (`definition` → OpenAI tool schema)
 *  - The **slash-command router** (`aliases`, `permissions`, `execute`)
 *  - The **`/menu` help system** (`name`, `description`, `category`, `aliases`)
 *
 * Minimal example:
 * ```ts
 * export class EchoTool extends BaseTool {
 *   readonly name = 'echo';
 *   readonly description = 'Echoes back the user input.';
 *   readonly aliases = ['e'];
 *   readonly category = 'utility';
 *   readonly permissions = 'user';
 *
 *   get definition(): ToolDefinition { ... }
 *
 *   async execute(args, ctx) {
 *     return args.text;
 *   }
 * }
 * ```
```

## `src/tools/MakeStickerTool.ts`

- **Lines of code**: 135
- **Description**:
```text
*
 * @file src/tools/MakeStickerTool.ts
 * @description Converts images or short videos into WhatsApp-compatible animated/static WebP stickers.
 *
 * Processing pipeline:
 *  1. Verify that the message (or its quoted message) contains a downloadable image or video.
 *  2. Await the background media download (`ctx.mediaReady`) — falls back to a direct
 *     `ctx.downloadMedia()` call if the cached file is missing (e.g., expired CDN link).
 *  3. Convert the buffer to WebP via FFmpeg (`StickerUtils.imageToWebp` / `videoToWebp`).
 *  4. Write WhatsApp-required EXIF metadata (pack name, author) using `StickerUtils.writeExif`.
 *  5. Send the final WebP buffer as a native WhatsApp sticker via `ctx.sendSticker()`.
 *
 * Requirements:
 *  - FFmpeg must be installed on the host system (used internally by `FFmpegConverter`).
 *  - The provider must implement `ctx.sendSticker()` (currently only WhatsApp does).
 *
 * Slash command aliases: `/s`, `/makesticker`, `/createsticker`
```

## `src/tools/RoleTool.ts`

- **Lines of code**: 363
- **Description**:
```text
*
 * @file src/tools/RoleTool.ts
 * @description Tool for managing user roles and per-role privileges.
 *
 * V7.11 set-based role model: user | premium | admin | owner
 *
 * Actions:
 *   grant    <user> <role> [scope]  — Assign a role to a user.
 *   revoke   <user> <role> [scope]  — Remove a specific role from a user.
 *   check    [user]                 — Show all roles & effective privileges of a user.
 *   list     [scope]                — List all explicitly-assigned roles for a scope.
 *   privs    <role>                 — Show current privileges for a role.
 *   setpriv  <role> <field> <value> — Override a privilege for a role (owner only).
 *   resetpriv <role>                — Reset a role to env/default privileges (owner only).
 *
 * Scope:
 *   - Omitted or "here"  → current chatId (group-local).
 *   - "global"           → applies everywhere.
 *
 * Permissions:
 *   - Viewing (check/list/privs): any user.
 *   - grant/revoke admin/premium: requires admin+.
 *   - grant/revoke owner: requires owner.
 *   - setpriv/resetpriv: owner only.
 *
 * Slash aliases: /role, /roles, /permission, /perm
```

## `src/tools/ConfigTool.ts`

- **Lines of code**: 164
- **Description**:
```text
*
 * @file src/tools/ConfigTool.ts
 * @description Dynamic per-room bot configuration tool.
 *
 * Allows group/chat admins to inspect and override the bot's behaviour for a
 * specific chat room without restarting the service.  All overrides are stored
 * in the `chat_rooms` table; a `null` value in the DB means "use the global
 * default" (see `ConfigService.getResolvedConfig` for the fallback chain).
 *
 * Supported actions:
 *  - `get`   — Show the current effective configuration (DB override or global default).
 *  - `set`   — Update a specific key for this room with input validation.
 *  - `reset` — Clear a key's override so it reverts to the global default.
 *
 * Configurable keys:
 *  | Key            | Type    | Description                                               |
 *  |----------------|---------|-----------------------------------------------------------|
 *  | systemPrompt   | string  | Custom LLM system prompt (max 50,000 chars)               |
 *  | contextLimit   | integer | Max messages in the context window (1–50)                 |
 *  | temperature    | float   | LLM sampling temperature (0.0–2.0)                        |
 *  | allowTools     | boolean | Enable/disable LLM function-calling for this room         |
 *  | autoReplyAll   | boolean | Reply to every group message without requiring a mention  |
 *  | summarize      | boolean | Compress old chat history into a rolling summary (V7.13)  |
 *
 * Permissions required: `admin`
 * Slash command aliases: `/conf`, `/settings`
```

## `src/tools/GroupAdminTool.ts`

- **Lines of code**: 156
- **Description**:
```text
*
 * @file src/tools/GroupAdminTool.ts
 * @description Comprehensive group management tool for WhatsApp groups.
 *
 * Handles all common group administration tasks:
 *   add      — Add a participant by phone number.
 *   remove   — Remove (kick) a participant.
 *   promote  — Promote a participant to group admin.
 *   demote   — Remove admin rights from a participant.
 *   mute     — Restrict who can send messages (admins only / everyone).
 *   link     — Get the group's invite link.
 *
 * User targeting:
 *  - @mention a user in the message
 *  - Reply (quote) to a target user's message
 *  - Type a phone number / LID / JID directly
 *  - The LLM can pass `"mentioned"` or `"quoted"` as the user arg
 *
 * Works conversationally ("kick @John", "promote this user to admin")
 * and via slash commands: /kick, /add, /promote, /demote, /mute, /grouplink
 *
 * Permissions: admin
```

## `src/tools/index.ts`

- **Lines of code**: 123
- **Description**:
```text
*
 * @file src/tools/index.ts
 * @description Central registry for all ElastraX tools (slash commands and LLM function calls).
 *
 * Tools are registered once at module load time.  The agent and command router look up
 * tools via the exported helper functions rather than importing each tool directly,
 * keeping them decoupled from individual implementations.
 *
 * To add a new tool:
 *  1. Create a class that extends `BaseTool` in a new file under `src/tools/`.
 *  2. Import it here and push an instance onto `toolsList`.
 *  3. The tool will automatically appear in:
 *     - `/menu` (help output)
 *     - LLM function-calling payload (if `allowTools` is enabled for the room)
 *     - The slash-command router (via the tool's `name` and `aliases`)
 *
 * Exported helpers:
 *  - `getToolByName(name)`         — Look up a tool by its exact LLM function name.
 *  - `getToolByAliasOrName(cmd)`   — Look up a tool by slash-command alias OR name.
 *  - `getToolDefinitions()`        — Return OpenAI-compatible tool definitions for all tools.
 *  - `tools`                       — The raw ordered list of all registered `BaseTool` instances.
```

## `src/tools/TranscribeTool.ts`

- **Lines of code**: 98

## `src/tools/DeleteMessageTool.ts`

- **Lines of code**: 72
- **Description**:
```text
*
 * @file src/tools/DeleteMessageTool.ts
 * @description Delete the bot's last message (or a specific quoted bot message).
 *
 * On WhatsApp, only the bot's own messages can be deleted for everyone.
 * The user must reply to a bot message or say "delete your last message" — the
 * LLM maps either form to this tool.
 *
 * Works conversationally ("delete that", "remove your last message")
 * and via slash command (/delete, /del — must reply to a bot message).
 *
 * Slash command aliases: /delete, /del, /unsend
```

## `src/tools/PDFTool.ts`

- **Lines of code**: 137
- **Description**:
```text
*
 * @file src/tools/PDFTool.ts
 * @description PDF utility tool for basic PDF operations.
 *
 * Provides information about a PDF and basic operations via pdf-lib.
 *
 * Actions:
 *   info     — Show page count and file size of an attached PDF.
 *   compress — Compress a PDF by re-encoding it (lossy; good for large scanned PDFs).
 *   to_images— Convert PDF pages to images via FFmpeg/Ghostscript (requires Ghostscript).
 *
 * Works conversationally ("how many pages is this PDF?", "compress this PDF")
 * and via slash command: /pdf [action]   — attach or reply to a PDF file.
 *
 * Slash command aliases: /pdf
 *
 * Dependencies: pdf-lib (install: bun add pdf-lib)
```

## `src/tools/IDTool.ts`

- **Lines of code**: 57
- **Description**:
```text
*
 * @file src/tools/IDTool.ts
 * @description Reveals platform identifiers for the current user and chat room.
 *
 * Very useful for debugging, for users wanting to find their chat/group ID
 * (e.g., to configure webhook targets or admin tools), and for admins who
 * need to whitelist specific JIDs.
 *
 * Works conversationally ("what's my ID?", "show me this group's ID")
 * and via slash command (/id).
 *
 * Slash command aliases: /id, /whoami
```

## `src/tools/MediaConvertTool.ts`

- **Lines of code**: 171
- **Description**:
```text
*
 * @file src/tools/MediaConvertTool.ts
 * @description Media format converter powered by FFmpeg.
 *
 * Converts an attached or quoted media file from one format to another using
 * the FFmpegConverter utility. Users can attach a file and request conversion,
 * or reply to a previously shared file.
 *
 * Supported conversions (non-exhaustive):
 *   Audio: mp3 ↔ ogg ↔ aac ↔ m4a ↔ opus ↔ wav
 *   Video: mp4 ↔ mkv ↔ webm ↔ gif
 *   Image: jpg ↔ png ↔ webp
 *   Cross:  video → audio (extract audio track)
 *
 * Works conversationally ("convert this to mp3") and via slash command:
 *   /convert [target_format]   — attach or reply to a media file
 *
 * Slash command aliases: /convert, /cv
```

## `src/tools/OwnerTool.ts`

- **Lines of code**: 175
- **Description**:
```text
*
 * @file src/tools/OwnerTool.ts
 * @description Owner-only bot administration tool.
 *
 * Provides privileged commands accessible only to the bot owner:
 *  - `broadcast` — Send a message to all known rooms on the current platform.
 *  - `leave`     — Make the bot leave the current group chat.
 *  - `system_info` — Show bot memory, uptime, and room count.
 *
 * Both slash-command and conversational invocation are supported:
 *   Slash:          /broadcast Hello everyone!
 *   Conversational: "broadcast a maintenance notice to all groups"
 *
 * Slash command aliases: /owner, /broadcast, /leave, /botleave
```

## `src/tools/MenfessTool.ts`

- **Lines of code**: 147
- **Description**:
```text
*
 * @file src/tools/MenfessTool.ts
 * @description Anonymous message forwarding (Menfess) tool.
 *
 * Allows users to send anonymous messages to a target group or private chat.
 * The tool uses a one-step confirmation flow: previews the message and asks
 * the user to confirm before sending.
 *
 * Conversational usage:
 *   User DMs: "send anonymous message to the family group: hey wanna hang out?"
 *   → AI calls menfess(target_chat_id, message)
 *   → Bot previews and asks for confirmation
 *   → User replies "yes" → message is forwarded with no sender attribution
 *
 * Slash command usage:
 *   /menfess [target_chat_id] [message]
 *
 * The target_chat_id can be:
 *   - A WhatsApp group JID (use /id in the target group to find it)
 *   - A keyword alias (the bot owner can pre-configure in env: MENFESS_TARGETS)
 *     e.g., MENFESS_TARGETS=family:120363xxxxxx@g.us,friends:120363yyyyyy@g.us
 *
 * Slash command aliases: /menfess, /anon
```

## `src/tools/ReminderTool.ts`

- **Lines of code**: 270
- **Description**:
```text
*
 * @file src/tools/ReminderTool.ts
 * @description Personal reminder / scheduler tool.
 *
 * Allows users to set, list, and cancel reminders. The AI parses natural language
 * time expressions ("in 30 minutes", "tomorrow at 3pm") and this tool persists
 * the reminders to the database. The Scheduler fires them at the right time.
 *
 * Both slash-command and conversational invocation are fully supported:
 *   Slash:          /remind in 30 minutes take your medication
 *   Conversational: "remind me in 30 minutes to take my medication"
 *
 * The `action` parameter lets the LLM also list and cancel reminders without
 * the user having to know separate commands.
 *
 * Slash command aliases: /remind, /reminder
```

## `src/tools/LanguageTool.ts`

- **Lines of code**: 81
- **Description**:
```text
*
 * @file src/tools/LanguageTool.ts
 * @description Per-room language configuration tool.
 *
 * Updates the `language` column of the active chat room in the database.
 * The selected language affects:
 *  - All system messages and error strings (via the `t()` i18n helper).
 *  - The `{{LANGUAGE}}` placeholder in the LLM system prompt, which instructs
 *    the model to reply in the chosen language.
 *
 * Supported language codes:
 *  - `en` — English (default)
 *  - `id` — Indonesian (Bahasa Indonesia)
 *
 * Permissions required: `user` (any participant can change the room language).
 * Slash command aliases: `/lang`, `/setlanguage`, `/setlang`
```

## `src/tools/PingTool.ts`

- **Lines of code**: 70
- **Description**:
```text
*
 * @file src/tools/PingTool.ts
 * @description Simple latency and uptime health-check tool.
 *
 * Measures the round-trip time from when the message arrives to when the bot
 * generates this response, and reports the process uptime.
 *
 * Works both as a slash command (/ping) and conversationally
 * ("are you online?", "what's your latency?").
 *
 * Slash command aliases: /ping, /status
```

## `src/tools/StatsTool.ts`

- **Lines of code**: 110
- **Description**:
```text
*
 * @file src/tools/StatsTool.ts
 * @description Chat room usage statistics tool.
 *
 * Queries the messages table to return summary stats for the current chat room:
 * total message count, bot vs human split, room age, and the most active user.
 *
 * Works both conversationally ("show me this room's stats", "how many messages have been sent?")
 * and via slash command (/stats).
 *
 * Slash command aliases: /stats, /statistics
```
