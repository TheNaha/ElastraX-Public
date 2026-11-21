# Configuration Reference

Every environment variable actually read by the code, with type, default, required/optional status, and purpose. Values marked *placeholder* are deliberately fake; never commit realistic-looking secrets.

Configuration is resolved from `process.env` at startup by `src/config/env.ts` (`validateEnv`), `src/config/runtime.ts`, `src/webhooks/config.ts`, and service-specific modules such as `src/utils/DigestService.ts`.

## 1. Bot Identity & Ownership

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `ELASTRAX_DB_PATH` | string | `./data/bot.db` | no | SQLite database path. `':memory:'` disables persistence. |
| `BOT_OWNER_JID` | string | *(none)* | yes (WhatsApp) | Full WhatsApp JID of the bot owner. Grants implicit `owner` permission everywhere. |
| `BOT_OWNER_DISCORD_ID` | string | `BOT_OWNER_JID` if set | no | Discord-specific owner ID, because a Discord id can never match `BOT_OWNER_JID`. |
| `BOT_OWNER_TELEGRAM_ID` | string | `BOT_OWNER_JID` if set | no | Telegram-specific owner ID, because a Telegram user id is numeric and can never match `BOT_OWNER_JID`. |

## 2. AI / LLM — Single-Provider Mode

Used when `AI_PROVIDERS` is **not** set.

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `AI_API_BASE_URL` | URL | *(none)* | yes (non-loopback) | OpenAI-compatible base URL. Cloudflare shorthand: if unset and `AI_CF_ACCOUNT_ID` is set, builds `https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`. http allowed on loopback and on a **literal** private-network address (RFC 1918, IPv6 ULA/link-local, CGNAT `100.64.0.0/10`); any other plain-http host needs `ALLOW_INSECURE_HTTP_ENDPOINTS=true`. |
| `AI_API_KEY` | string | *(none)* | yes (non-loopback) | API key / bearer token. Falls back to `AI_CF_API_TOKEN`. |
| `AI_MODEL_NAME` | string | *(none)* | yes (single-provider) | Model name. Required in single-provider mode: `validateEnv` (`src/config/env.ts`) throws at startup if it is unset, before any provider is resolved. `resolveLLMProviders` (`src/config/llm.ts`) keeps `meta-llama/Meta-Llama-3-8B-Instruct` as a read-time fallback, but it is unreachable once `validateEnv` has run. |
| `AI_CF_ACCOUNT_ID` | string | *(none)* | no | Cloudflare account ID (auto-builds `AI_API_BASE_URL`). |
| `AI_CF_API_TOKEN` | string | *(none)* | no | Cloudflare API token (used as `AI_API_KEY` fallback). |
| `ALLOW_INSECURE_HTTP_ENDPOINTS` | boolean | `false` | no | Accept plain `http://` for credential-bearing endpoints that otherwise require https: `AI_API_BASE_URL`, every `AI_<NAME>_BASE_URL`, and `TRANSCRIBE_ENDPOINT`. Needed for a host that is a public address or a DNS name (`http://inference.corp.example/v1`); literal private addresses are accepted without it. The API key then travels in cleartext, so a startup warning is logged when it is on. Values other than `true`/`false` fail startup. |

## 3. AI / LLM — Multi-Provider Failover Mode

Used when `AI_PROVIDERS` is set to a comma-separated list (e.g. `modal,gemini`). Single-provider vars above are ignored.

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `AI_PROVIDERS` | string | *(none)* | yes | Comma-separated provider names (`a-z0-9_-`), no duplicates. |
| `AI_<NAME>_BASE_URL` | URL | *(none)* | yes | Per-provider base URL. Cloudflare shorthand via `AI_<NAME>_CF_ACCOUNT_ID`. |
| `AI_<NAME>_API_KEY` | string | *(none)* | yes (non-loopback) | Per-provider key. Falls back to `AI_<NAME>_CF_API_TOKEN`. |
| `AI_<NAME>_MODEL` | string | provider default | yes | Per-provider model. Provider defaults: gemini `gemini-2.0-flash`, openrouter `google/gemini-2.0-flash-001`, groq/cloudflare/pollinations/airforce `gpt-4o-mini`; any other name also resolves to `gpt-4o-mini`. (`meta-llama/Meta-Llama-3-8B-Instruct` is the single-provider fallback, not a multi-provider default.) |
| `AI_<NAME>_TIER` | string | `standard` | no | `standard`, `fast`, or `powerful`. Anything else aborts startup. |
| `AI_<NAME>_SUPPORTS_IMAGE` | boolean | `true` | no | Send `image_url` content blocks. |
| `AI_<NAME>_SUPPORTS_VIDEO` | boolean | `true` for `modal*` prefix, else `false` | no | Send `video_url` content blocks. |
| `AI_<NAME>_SUPPORTS_AUDIO` | boolean | `true` for `modal*` prefix, else `false` | no | Send `audio_url` content blocks. |
| `AI_<NAME>_SUPPORTS_TOOLS` | boolean | `true` | no | Advertise tool/function calling. |
| `AI_<NAME>_STREAM_USAGE` | boolean | `true` | no | Request usage in streaming responses. |
| `AI_<NAME>_SUPPORTS_PARALLEL_TOOLS` | boolean | unset | no | Advertise parallel tool calls. Unset leaves the client default. |
| `AI_<NAME>_MAX_TOKENS_PARAM` | string | `max_tokens` | no | Request field used for the token cap. Must be `max_tokens` or `max_completion_tokens`; any other value fails startup. |
| `AI_<NAME>_MAX_OUTPUT_TOKENS` | integer | `AI_MAX_TOKENS` | no | Per-provider output cap. Overrides the global request `maxTokens`. |

Global (single-provider or no-prefix) equivalents: `AI_TIER`, `AI_SUPPORTS_IMAGE`, `AI_SUPPORTS_VIDEO`, `AI_SUPPORTS_AUDIO`, `AI_SUPPORTS_TOOLS`, `AI_STREAM_USAGE`, `AI_SUPPORTS_PARALLEL_TOOLS`, `AI_MAX_TOKENS_PARAM`, `AI_MAX_OUTPUT_TOKENS`.

## 4. AI Behaviour Defaults

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `AI_MAX_TOKENS` | integer | `2048` | no | Max tokens per LLM response. Range 1–1,000,000. |
| `AI_TIMEOUT_MS` | integer | `60000` | no | LLM request timeout in ms. Range 1,000–600,000. Streaming path uses `120000` fallback. |
| `AI_TOOL_TIMEOUT_MS` | integer | `30000` | no | LLM tool-call timeout in ms. Range 1,000–600,000. |
| `AI_PROVIDER_COOLDOWN_MS` | integer | `30000` | no | Cooldown before retrying a failed AI provider in failover mode. Range 1,000–3,600,000. |
| `AI_TIER` | string | *(unset)* | no | Global tier tag: `standard`, `fast`, or `powerful`. Invalid values abort startup. |
| `AI_VERBOSE_LOGS` | boolean | `false` | no | Print raw AI prompts/responses to terminal. |
| `AI_MAX_TOOL_ITERATIONS` | integer | `8` | no | Max LLM loop iterations per AI turn (each iteration may emit tool calls). Range 1–20. |
| `AI_MAX_TOOL_CALLS` | integer | `8` | no | Hard cap on tool calls inside one turn. `TurnBudget` clamps any value above **8**; the env var can only lower it. |
| `AI_MAX_PARALLEL_TOOLS` | integer | `4` | no | Hard cap on concurrent tool calls in one batch. `TurnBudget` clamps any value above **4**; the env var can only lower it. |
| `AI_MAX_TOOL_RESULT_BYTES` | integer | `1048576` (1 MB) | no | Largest single tool result, in bytes. Range 1,024–10,485,760. |
| `AI_MAX_TOOL_RESULT_BYTES_TOTAL` | integer | `4194304` (4 MB) | no | Largest sum of tool results in one turn. Range 1,024–41,943,040. |
| `AI_OPERATIONAL_CONTEXT_LIMIT` | integer | `1000` | no | Cap used for operational/tool context trimming. Range 1–10,000. |
| `AI_MAX_RESPONSE_BYTES` | integer | `2097152` (2 MB) | no | Reject an LLM response body larger than this. The built-in guard is 2 MB. |
| `AI_STREAMING` | boolean | `false` | no | Enable real-time streaming updates using message editing. |
| `STREAMING_EDIT_INTERVAL_WA` | integer | `1500` | no | Milliseconds between WhatsApp edits (prevents rate limits). Range 100–30,000. |
| `STREAMING_EDIT_INTERVAL_DC` | integer | `500` | no | Milliseconds between Discord edits. Range 100–30,000. |
| `STREAMING_EDIT_INTERVAL_TG` | integer | `1500` | no | Milliseconds between Telegram edits. The Bot API allows roughly one per chat per second. Range 100–30,000. |
| `TOOL_LOADING_MODE` | string | `search` | no | `search` = essential + triggered tools only; `all` = legacy, all permitted tools in every request. |
| `TOOL_MUTATION_COST_LIMIT` | integer | `100` | no | Max cost a single user may spend on mutating tools per 60 s window. Range 1–1,000. |
| `AI_TEMPERATURE` | float | `0.7` | no | Default sampling temperature, 0.0–2.0. Overridable per-chat via `/config`. |

## 5. Conversation Defaults

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `CONTEXT_MESSAGE_LIMIT` | integer | `10` | no | Recent messages included in LLM context window. Range -1 (unlimited)–10,000. |
| `CONTEXT_SUMMARIZE` | boolean | `true` | no | Compress old messages into a rolling summary instead of dropping them. Per-chat override via `/config`. |
| `AUTO_REPLY_ALL` | boolean | `false` | no | Reply to every message in group chats by default (not just mentions/replies). |
| `ALLOW_TOOLS` | boolean | `true` | no | Default for whether the model may call tools in a chat. Overridable per chat via `/config`. |
| `DEFAULT_SYSTEM_PROMPT` | string | built-in default | no | Default system prompt. Use `{{LANGUAGE}}` placeholder. Two media-service variants documented in `.env.example`. |
| `LONG_TERM_MEMORY` | boolean | `true` in DMs, `false` in groups | no | Global default for long-term memory; per-chat override via `/config`. The DM/group difference is the built-in default when unset. |

Reply language has no environment variable. It is per-room state (`chat_rooms.language`, default `en`) changed with `/language`, and the `{{LANGUAGE}}` placeholder above is filled from it. See [Localisation](./i18n.md).

## 6. Platform Providers

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `DISCORD_BOT_TOKEN` | string | `dummy_token_here` | no | Discord bot token. Leave blank or dummy to disable Discord. |
| `TELEGRAM_BOT_TOKEN` | string | *(unset)* | no | Optional Telegram provider via grammY. Without it, reports `not_configured`; boot continues. |
| `BOT_OWNER_TELEGRAM_ID` | string | *(unset)* | no | Required with Telegram for owner-only tools. |
| `BOT_OWNER_DISCORD_ID` | string | *(unset)* | no | Required with Discord for owner-only tools. |

## 7. Rate Limiting (legacy global fallback)

Only read by the legacy `RateLimiter.check()` path. Per-user limits come from role privileges (`ROLE_PRIV_*` / DB overrides); these are fallback defaults for users with no privilege data.

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `RATE_LIMIT_MESSAGES` | integer | `10` | no | Max messages a non-admin user can send within the window. Range 1–100,000. |
| `RATE_LIMIT_WINDOW_SEC` | integer | `60` | no | Window duration in seconds. Range 1–86,400. |

## 8. Per-Role Privilege Defaults

Override role defaults via `ROLE_PRIV_{ROLE}_{FIELD}` env vars. -1 = unlimited. Also overridable in DB via `/role setpriv`.

| Variable | Type | Default |
|---|---|---|
| `ROLE_PRIV_USER_MESSAGES_PER_WINDOW` | integer | `10` |
| `ROLE_PRIV_USER_RATE_WINDOW_SEC` | integer | `60` |
| `ROLE_PRIV_USER_CONTEXT_LIMIT` | integer | `20` |
| `ROLE_PRIV_USER_MAX_DOWNLOAD_MB` | integer | `25` |
| `ROLE_PRIV_PREMIUM_MESSAGES_PER_WINDOW` | integer | `30` |
| `ROLE_PRIV_PREMIUM_CONTEXT_LIMIT` | integer | `50` |
| `ROLE_PRIV_PREMIUM_MAX_DOWNLOAD_MB` | integer | `100` |
| `ROLE_PRIV_ADMIN_MESSAGES_PER_WINDOW` | integer | `30` |
| `ROLE_PRIV_ADMIN_CONTEXT_LIMIT` | integer | `50` |
| `ROLE_PRIV_ADMIN_MAX_DOWNLOAD_MB` | integer | `100` |
| `ROLE_PRIV_OWNER_MESSAGES_PER_WINDOW` | integer | `-1` |
| `ROLE_PRIV_OWNER_CONTEXT_LIMIT` | integer | `100` |
| `ROLE_PRIV_OWNER_MAX_DOWNLOAD_MB` | integer | `-1` |

A permission check requires the **exact** role: `user` is implicit for everyone and `owner` satisfies every check, but `premium` does not imply `admin` (`roleSatisfies` in `src/core/roleAccess.ts`). The defaults above merely grow with the role name. `ROLE_PRIV_{ROLE}_RATE_WINDOW_SEC` exists for every role (default `60`) and is not listed per role above for brevity. Out-of-range values fall back to the built-in defaults (the table above).

## 9. Media / Downloads

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `YTDLP_PATH` | string | `yt-dlp` | no | Path to the yt-dlp binary (resolved from PATH by default). |
| `DOWNLOAD_MAX_MB` | integer | `50` | no | Max download file size in MB before the bot refuses to send. Range 1–1,024. |
| `MEDIA_CLEANUP_INTERVAL_MS` | integer | `21600000` (6 h) | no | Periodic cleanup interval for cached media files. Range 60,000–86,400,000. |
| `MEDIA_RETENTION_HOURS` | integer | `72` | no | Delete cached media files older than this many hours. Range 1–8,760. |
| `ELASTRAX_MEDIA_DIR` | string | `./data/media` | no | Media storage directory. |
| `MEDIA_STORAGE_MAX_FILES` | integer | `1000` | no | Max media files stored. |
| `MEDIA_STORAGE_MAX_MB` | integer | `500` | no | Max media storage in MB. |
| `ELASTRAX_DOWNLOAD_DIR` | string | *(unset)* | no | Binary path override. |
| `ELASTRAX_FFMPEG_DIR` | string | *(unset)* | no | Binary path override. |

## 10. Voice Transcription

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `TRANSCRIBE_ENDPOINT` | URL | *(unset)* | no | External transcription service (Whisper API compatible). Leave unset to disable. Must be https unless it points at a loopback or literal private address (or `ALLOW_INSECURE_HTTP_ENDPOINTS=true`): it carries an API key. |
| `TRANSCRIBE_API_KEY` | string | *(unset)* | no | Bearer token for the transcription service. |
| `TRANSCRIBE_TIMEOUT_MS` | integer | `45000` | no | Timeout for transcription requests in ms. Range 1,000–600,000. |
| `TRANSCRIBE_MODE` | string | `multipart` | no | `multipart` (default) or `json`. |

## 11. Web Search / Scrape

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `SEARXNG_URL` | URL | *(unset)* | no | SearXNG instance URL used by the `web_search` tool. The tool stays registered when unset, but every call answers that web search is not configured. Plain http is accepted on any host, because a self-hosted instance often has no TLS. (`.env.example` ships a placeholder URL.) |
| `JINA_API_KEY` | string | *(unset)* | no | Optional Jina.ai API key used by the `web_scrape` tool. |

## 12. Webhook Inbound Server

Webhook intake is enabled by default (`WEBHOOK_ENABLED=true`). Native processes bind loopback only.

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `WEBHOOK_ENABLED` | boolean | `true` | no | Reject `POST /webhook*` with `503` when `false`. The listener still binds, so `/health`, `/live`, `/ready`, `/metrics` and `/admin` keep serving. |
| `WEBHOOK_HOST` | string | `127.0.0.1` | no | Bind address: `127.0.0.1`, `::1`, or `0.0.0.0` (latter requires `WEBHOOK_CONTAINER_MODE=true`). |
| `WEBHOOK_PORT` | integer | `3500` | no | Listen port. `0` binds an ephemeral port (CI smoke test). Range 0–65,535. |
| `WEBHOOK_SECRET` | string | *(unset)* | no | Required for `/webhook` and `/webhook/github`. At least 24 bytes. Prefer `X-Webhook-Secret` header. |
| `WEBHOOK_CONTAINER_MODE` | boolean | `false` | no | Must be `true` to allow `WEBHOOK_HOST=0.0.0.0` (Docker only). |
| `WEBHOOK_BODY_SECRET_COMPAT_ENABLED` | boolean | `false` | no | Enable legacy JSON-body `secret` auth in a bounded window. |
| `WEBHOOK_BODY_SECRET_COMPAT_UNTIL` | RFC3339 | *(unset)* | no | Expiry for body-secret compat. Required when enabled; must be future-dated. |
| `WEBHOOK_QUERY_SECRET_COMPAT_ENABLED` | boolean | `false` | no | Enable legacy `?secret=` query auth in a bounded window. |
| `WEBHOOK_QUERY_SECRET_COMPAT_UNTIL` | RFC3339 | *(unset)* | no | Expiry for query-secret compat. |
| `WEBHOOK_MAX_BODY_BYTES` | integer | `262144` | no | Max body bytes (413 if exceeded). Range 1,024–10,485,760. |
| `WEBHOOK_MAX_TEXT_LENGTH` | integer | `3500` | no | Formatted chat text truncation. Range 200–20,000. |
| `WEBHOOK_MAX_DESTINATIONS` | integer | `25` | no | Fan-out destination cap. Range 1–100. |
| `WEBHOOK_MAX_SOURCE_LENGTH` | integer | `128` | no | Source name length cap. Range 8–1,024. |
| `WEBHOOK_MAX_ROOM_ID_LENGTH` | integer | `256` | no | Room id length cap. Range 16–512. |
| `WEBHOOK_BODY_READ_TIMEOUT_MS` | integer | `5000` | no | Body read timeout in ms (408 if exceeded). Range 100–30,000. |
| `WEBHOOK_ENQUEUE_TIMEOUT_MS` | integer | `5000` | no | Durable enqueue timeout in ms. Range 100–30,000. |
| `WEBHOOK_READINESS_TIMEOUT_MS` | integer | `2000` | no | Readiness check timeout in ms. Range 100–10,000. |
| `WEBHOOK_RATE_LIMIT_MAX` | integer | `60` | no | Token-bucket max requests per window. Range 1–10,000. |
| `WEBHOOK_RATE_LIMIT_WINDOW_MS` | integer | `60000` | no | Rate-limit window in ms. Range 1,000–3,600,000. |
| `WEBHOOK_RATE_LIMIT_MAX_SOURCES` | integer | `10000` | no | Max tracked rate-limit keys. Range 100–100,000. |
| `WEBHOOK_REPLAY_TTL_MS` | integer | `86400000` | no | Replay-deduplication TTL in ms (default 24 h). Range 1,000–604,800,000. |
| `WEBHOOK_REPLAY_MAX_ENTRIES` | integer | `10000` | no | Max replay cache entries. Range 100–100,000. |

## 13. Media Services Integration (Seerr / Jellyfin)

Each media route fails closed with HTTP 503 until its own 24+ byte secret is set.

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `SEERR_API_URL` | URL | *(unset)* | no | Jellyseerr/Overseerr API base URL. Plain http is accepted on any host (self-hosted installs often have no TLS). |
| `SEERR_API_KEY` | string | *(unset)* | no | Seerr API key. |
| `SEERR_URL` | string | *(unset)* | no | HealthMonitor fallback URL for Seerr. |
| `SEERR_WEBHOOK_SECRET` | string | *(unset)* | no | Seerr webhook secret (24+ bytes). |
| `JELLYFIN_API_URL` | URL | *(unset)* | no | Jellyfin API base URL. Plain http is accepted on any host (self-hosted installs often have no TLS). |
| `JELLYFIN_API_KEY` | string | *(unset)* | no | Jellyfin API key / user identifier. |
| `JELLYFIN_EXTERNAL_URL` | URL | *(unset)* | no | User-facing URL for watch links (must use https unless loopback). |
| `JELLYFIN_URL` | string | *(unset)* | no | HealthMonitor fallback URL for Jellyfin. |
| `JELLYFIN_WEBHOOK_SECRET` | string | *(unset)* | no | Jellyfin webhook secret (24+ bytes). |
| `JELLYFIN_PUBLIC_LIBRARY` / `MEDIA_PUBLIC_LIBRARY` / `ENABLE_MEDIA_LIBRARY` / `JELLYFIN_PUBLIC_MODE` | boolean | `false` (each) | no | Aliases for the same switch: if **any** is true, `/library` allows browsing without a bound Jellyfin user. |

## 14. Scheduled Digests

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `DIGEST_ENABLED` | boolean | `false` | no | Nightly per-room conversation summaries. |
| `DIGEST_MEDIA_ENABLED` | boolean | `false` | no | Weekly Jellyfin "new media" rollup. |
| `DIGEST_HOUR_UTC` | integer | `8` | no | Hour of day (UTC) when digest jobs fire. Range 0–23. |
| `DIGEST_ROOMS` | string | *(empty)* | no | Comma-separated room ids for daily digests. Empty = none. |
| `DIGEST_LOOKBACK_HOURS` | integer | `24` | no | How far back the nightly summary looks. Range 1–720. |
| `DIGEST_MAX_MESSAGES` | integer | `500` | no | Max messages fed to the LLM per digest. Range 1–1,000. |

On-demand digests are always available in-chat via `/digest [hours]` (1–168).

## 15. Scheduled Agent Tasks

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `SCHEDULED_TASKS_ENABLED` | boolean | `false` | no | Enable `/task` reminder execution as agent turns. |
| `SCHEDULED_TASKS_ALLOWED_ROOMS` | string | *(empty)* | no | Comma-separated rooms allowed to run tasks. Each entry may be a canonical room key (`room:<platform>:<id>`) or the raw remote room id. |
| `SCHEDULED_TASKS_MAX_RUNS_PER_DAY` | integer | `20` | no | Daily run ceiling. |
| `SCHEDULED_TASKS_MAX_RUNS_PER_ROOM_PER_DAY` | integer | `4` | no | Per-room daily run ceiling. |
| `SCHEDULED_TASKS_TIMEOUT_MS` | integer | `120000` | no | Per-run timeout in ms. Range 5,000–900,000. |

## 16. Knowledge Base OCR

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `KB_OCR_ENABLED` | boolean | `true` | no | OCR images/scanned PDFs before chunking into room knowledge base. |
| `KB_OCR_MAX_BYTES` | integer | `8388608` | no | Max bytes for OCR input (8 MB). |
| `KB_OCR_MAX_OUTPUT_TOKENS` | integer | `2048` | no | Max output tokens from the vision model. |
| `KB_OCR_TIER` | integer | `0` | no | Model tier for OCR. |

## 17. Reaction Feedback

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `FEEDBACK_LOG_ENABLED` | boolean | `true` | no | Append reactions to a JSONL eval log. Opt-out: only `0`, `false`, `no`, or `off` disables it. Metrics are always collected. |
| `FEEDBACK_LOG_PATH` | string | `data/feedback.jsonl` | no | Path for the JSONL eval log and for reading feedback in the admin UI. |
| `FEEDBACK_MAX_PER_DAY` | integer | `2000` | no | Daily volume cap for feedback. |

## 18. Database Backups

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `BACKUP_DIR` | string | `./data/backups` | no | `bun run db:backup` snapshot directory. |
| `BACKUP_KEEP` | integer | `7` | no | Number of backups to retain. |

## 19. Runtime

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `NODE_ENV` | string | `development` | no | `production` disables the pretty log transport (raw JSON lines). Any other value keeps human-readable colored logs. |

## 20. Logging

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `LOG_LEVEL` | string | `info` | no | Pino level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |

## 21. Database (advanced)

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `ELASTRAX_DB_SYNCHRONOUS` | string | `FULL` | no | `OFF`, `NORMAL`, or `FULL`. |
| `ELASTRAX_DB_BUSY_TIMEOUT_MS` | integer | `5000` | no | SQLite busy timeout in ms. Range 0–120,000. |

## 22. Plugins

| Variable | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `PLUGIN_ALLOWED_PERMISSIONS` | string | `user,premium` | no | Comma-separated plugin permission ceiling: the highest level listed is the maximum a plugin may declare, and lower levels are admitted with it. Plugins declaring a higher permission are refused. |
| `ENABLE_PLUGIN_RELOAD` | boolean | `false` | no | Enables the owner-only `/reload` plugin tool (requires `PLUGIN_ALLOWED_PERMISSIONS` including `owner`). |

## 23. Opt-in tools (feature flags)

Each flag governs exactly one tool; unset means the tool is not registered at all.

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `ENABLE_GAME_SEARCH` | boolean | `false` | Register `GameSearchTool` (`/search` games). |
| `ENABLE_SOFTWARE_SEARCH` | boolean | `false` | Register `SoftwareSearchTool`. |
| `TTS_API_KEY` | string | *(unset)* | Register `SpeakTool` (`/speak` TTS voice notes). Without it, `SpeakTool` is absent from `/menu` and the model's tool list. |

## 24. Test & Dev Overrides

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `ELASTRAX_TEST_DOWNLOAD_DIR` | string | *(unset)* | Override download directory for tests (used by `DownloadTool`). |
| `ELASTRAX_TEST_FFMPEG_DIR` | string | *(unset)* | Override FFmpeg/ffprobe directory for tests (used by media conversion). |
| `ADMIN_COOKIE_INSECURE` | boolean | `false` | Allow insecure cookies for local/admin dev (sets cookie `Secure=false`). Only for loopback over plain HTTP. |
| `FIXTURE_DUMP_DIR` | string | `./test/fixtures/wa_messages` | Fixture output directory. |
| `ALLOW_FIXTURE_DUMP` | boolean | `false` | Set `true` only for `bun run fixtures:dump`. Disabled in production. |
| `DB_BACKUP_PATH` / `DB_RESTORE_PATH` | string | *(unset)* | Runtime-internal overrides for `scripts/dbBackup.ts` (not in `.env.example`). |

## 25. Message Queue

Inbound handling is bounded per room and globally by `src/utils/MessageQueue.ts`. Work is serialized per room (concurrency 1), and at most **8** tasks run concurrently across all rooms — `MessageQueue`'s `maxRunning` default; it is not an environment variable. `MESSAGE_QUEUE_GLOBAL_LIMIT` is the *backlog* cap, not the running cap; a value below `MESSAGE_QUEUE_PER_ROOM_LIMIT` is raised to the per-room limit with a warning, because a single room may queue that many.

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `MESSAGE_QUEUE_PER_ROOM_LIMIT` | integer | `50` | Max **pending** messages per room. Range 1–1,000. |
| `MESSAGE_QUEUE_GLOBAL_LIMIT` | integer | `500` | Max **pending** messages across all rooms (backlog cap, not the running cap). Range 1–10,000. |
| `MESSAGE_QUEUE_MAX_AGE_MS` | integer | `300000` (5 min) | Drop queued work older than this during overload. Range 10,000–3,600,000. |
| `MESSAGE_QUEUE_SHUTDOWN_GRACE_MS` | integer | `15000` | Time allowed for the queue to drain during shutdown. Range 1,000–120,000. |

## 26. Semantic Memory / Embeddings

When `EMBEDDING_API_URL` and `EMBEDDING_MODEL` are both set, memories are embedded and ranked by cosine similarity to the current message, and near-duplicates are suppressed on write. Unset disables semantic ranking and dedupe; recency ranking still applies.

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `EMBEDDING_API_URL` | URL | *(unset)* | OpenAI-compatible embeddings base. Accepts `…/v1/embeddings`, `…/v1`, or a bare host. |
| `EMBEDDING_API_KEY` | string | *(unset)* | Bearer token for the embeddings endpoint. Unset sends no `Authorization` header. |
| `EMBEDDING_MODEL` | string | *(unset)* | Embedding model name. Required with `EMBEDDING_API_URL`. |
| `EMBEDDING_TIMEOUT_MS` | integer | `8000` | Per-request timeout; non-positive or malformed falls back to 8,000. |
| `EMBEDDING_DIMENSION` | integer | auto-detected | Expected vector size. Omit to detect from the first response; set it when a model's size must be pinned. |
| `EMBEDDING_CANDIDATES` | integer | `400` | Recent memories scanned for injection and dedupe. Cap 10,000. |
| `EMBEDDING_DEDUPE_THRESHOLD` | float | `0.93` | Cosine similarity at which a new memory counts as a duplicate. Cap 1. |

After changing the embedding model, re-embed stored rows with `bun run db:embed` (see [scripts.md](./scripts.md)).

## 27. Text-to-Speech (voice replies)

`SpeakTool` is registered only when `TTS_API_KEY` is set. `src/utils/tts.ts` accepts any OpenAI-compatible `/v1/audio/speech` endpoint or ElevenLabs.

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `TTS_PROVIDER` | string | `openai` | `openai` (any OpenAI-compatible server) or `elevenlabs`. Any other value resolves to `openai`. |
| `TTS_API_KEY` | string | *(unset)* | API key. With no key the tool is not registered at all. |
| `TTS_BASE_URL` | URL | `https://api.openai.com` | Provider base URL. ElevenLabs defaults to `https://api.elevenlabs.io`. |
| `TTS_MODEL` | string | `tts-1` | Model id. ElevenLabs defaults to `eleven_multilingual_v2`. |
| `TTS_VOICE` | string | `alloy` | Voice id. Required for ElevenLabs (there is no meaningful default, so an unset voice disables the tool). |
| `TTS_MAX_CHARS` | integer | `2000` | Input character cap. Range 1–20,000. |
| `TTS_TIMEOUT_MS` | integer | `60000` | Request timeout. Range 1,000–300,000. |

## 28. Menfess relay

`MenfessTool` (`/menfess`, `/anon`) relays a message to an allowlisted destination.

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `MENFESS_TARGETS` | string | *(empty)* | Comma-separated `alias:chatId` pairs or bare chat IDs. An alias form becomes `/menfess <alias>`; a bare ID becomes directly addressable. Without this variable the tool has no destinations. |

## 29. Operations

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `LOG_ROOT` | string | `LOG_ROOT` if set; else the first existing of `<repo>/logs`, `/var/log/elastrax`; else `$HOME/.local/share/elastrax/logs` (returned without an existence check); else `/tmp/elastrax-logs` when `HOME` is unset | Directory `OwnerTool` reads when an owner asks for log/system information. |
| `WA_AUTH_IMPORT_DIR` | string | *(unset)* | One-time import of a legacy Baileys auth directory into the database-backed auth store. Only read when no stored credentials exist. |
| `RETENTION_*` | — | dry-run by default | Retention knobs are documented in [database.md](./database.md#retention). |

## How defaults are enforced

- `validateEnv` (`src/config/env.ts`) throws at startup if any required var is missing or malformed: bad booleans, non-integer bounds, weak `WEBHOOK_SECRET`/`SEERR_WEBHOOK_SECRET`/`JELLYFIN_WEBHOOK_SECRET` values (< 24 bytes), non-RFC3339 compatibility deadlines, unsafe hosts (plain-http URLs outside the loopback/self-hosted exceptions above), and credentials in URLs. `METRICS_AUTH_TOKEN` is deliberately exempt from that hard check (see below).
- `readIntegerEnv` / `readFloatEnv` / `readBooleanEnv` (`src/config/runtime.ts`) fall back to the documented default with a warning when a value is malformed (except in test, where no warning is logged).
- `readSecret` / `readOptionalSharedSecret` (`src/webhooks/config.ts`) enforce the 24-byte minimum and reject whitespace-padded secrets; a too-short `METRICS_AUTH_TOKEN` disables `/metrics` and `/admin` rather than aborting boot.