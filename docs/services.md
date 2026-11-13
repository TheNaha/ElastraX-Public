# Background Services

ElastraX runs several long-lived services and timers inside the single bot process. They are owned by `src/runtime/AppRuntime.ts`, which starts them after providers connect and stops them gracefully on shutdown. All interval timers are `unref()`'d so they do not keep the process alive on their own.

## Service list

| Service | File | What it does |
|---|---|---|
| AppRuntime | `src/runtime/AppRuntime.ts` | Process-level coordinator: starts providers, message queue, scheduler, digest service, webhook server, health monitor, and all background timers. |
| MessageQueue | `src/utils/MessageQueue.ts` | Per-room bounded queue for inbound message handling; serializes work per room, bounds global pending work, supports shutdown drain. |
| Scheduler | `src/utils/Scheduler.ts` | Cron/countdown reminders from the `reminders` table; drives scheduled agent tasks (`/task ` marker). Polls every 30 s. |
| DigestService | `src/utils/DigestService.ts` | Nightly per-room conversation summaries + weekly Jellyfin "new media" rollup; exactly-once delivery via `app_kv` markers. Polls every 60 s. |
| HealthMonitor | `src/utils/HealthMonitor.ts` | Pings Jellyfin, Seerr, each configured LLM provider, and yt-dlp every 60 s; records service health in `HealthMetrics`. |
| InboxService | `src/messaging/InboxService.ts` | At-least-once inbound deduplication: admits provider events into `message_inbox`, dedupes by `platform:event_key`, leases rows for 120 s, dead-letters after 5 attempts. |
| OutboxService | `src/messaging/OutboxService.ts` | Durable outbound delivery: enqueues replies/reminders/webhook messages, claims and delivers with retries and exponential backoff, dead-letters after 5 attempts. |
| MediaService | `src/utils/MediaService.ts` | Jellyfin client for media rollups and watch links. |
| NotificationSubscriptionService | `src/utils/NotificationSubscriptionService.ts` | Room-level notification subscriptions (seerr/jellyfin, notify types). |
| ConfigService | `src/utils/ConfigService.ts` | Per-room resolved config: system prompt, context limit, temperature, allow tools, auto-reply-all, summarize, long-term memory. |
| AuthService | `src/utils/AuthService.ts` | Role and privilege resolution for senders; merges DB roles with role defaults. |
| EmbeddingService | `src/utils/EmbeddingService.ts` | Semantic memory embeddings and near-duplicate suppression (OpenAI-compatible embeddings endpoint). |
| MediaCleanup | `src/utils/MediaCleanup.ts` | Deletes cached media files older than `MEDIA_RETENTION_HOURS`; runs on startup and every `MEDIA_CLEANUP_INTERVAL_MS`. |
| RateLimiter | `src/utils/RateLimiter.ts` | Token-bucket rate limiting per sender/platform; pruned every 10 minutes. |
| FlowHandler | `src/core/FlowHandler.ts` | Interactive multi-step flow state machine in SQLite; TTL-pruned every hour. |

## AppRuntime lifecycle

`src/runtime/AppRuntime.ts` is the process coordinator. Its `start()` sequence:

1. Wait for the tool registry (`registryReady`) so slash commands and LLM tool lookups never hit an empty registry.
2. Register all flow processors via `safeRegisterFlows()`.
3. Register `onMessage` handlers on every provider.
4. Start all providers via `Promise.allSettled`. A provider that fails to start is logged and skipped (degraded mode); a provider that connects asynchronously (WhatsApp reports `running` only from its socket `open` handler) is still included in `activeProviders` so late-connecting providers receive traffic.
5. Register the admin dashboard handler, provider senders, scheduled tasks, webhook readiness check, and (if present) the durable outbox enqueuer.
6. Start the webhook server (`Bun.serve`), the scheduler (30 s poll), the digest service (60 s poll), and the health monitor (60 s pings).
7. Start background timers (see below).

`stop()` is idempotent: once shutdown completes, a second `stop()` is a no-op. During boot, `stopRequested` is observed at every await boundary so a SIGTERM mid-boot unwinds instead of binding the HTTP listener against a closed database.

### Background timers (started by `startBackgroundTasks`)

| Timer | Interval | Action |
|---|---|---|
| Rate-limiter prune | 10 min | `RateLimiter.prune()` |
| Outbox worker | 1 s | `OutboxService.claim` + delivery, concurrency 10 (only when a durable store is present) |
| Outbox prune | 1 h | `OutboxService.prune` removes terminal rows older than `MEDIA_RETENTION_HOURS` |
| Inbox recovery | 1 h | `InboxService.recoverStranded` (24 h lease) re-claims `received`/expired-lease rows |
| Flow-session TTL prune | 1 h | `FlowHandler.pruneAllExpired` (24 h local TTL) |
| Media cleanup | startup + `MEDIA_CLEANUP_INTERVAL_MS` (default 6 h) | `MediaCleanup.pruneOldFiles` deletes files older than `MEDIA_RETENTION_HOURS` |
| Retention maintenance | startup + 24 h | `runRetentionMaintenance` (dry-run unless `RETENTION_DRY_RUN=false`) |
| Startup coverage scan | once, 5 s after boot | `runStartupCoverageScan` (non-fatal; only wired when `runStartupCoverageScan` is passed) |
| Scheduler | 30 s | `Scheduler.processReminders` |
| Digest service | 60 s | `DigestService.processDue` |
| Health monitor | 60 s | `HealthMonitor` pings |

## Service configuration

Configuration knobs live in `.env.example` and are summarized in `docs/configuration.md`:

- `MEDIA_CLEANUP_INTERVAL_MS` (default `21600000` / 6 h), `MEDIA_RETENTION_HOURS` (default `72`)
- `RETENTION_DRY_RUN` (default `true`), `RETENTION_MESSAGES_DAYS` (180), `RETENTION_MESSAGE_GRACE_DAYS` (30), `RETENTION_TERMINAL_DELIVERY_DAYS` (90), `RETENTION_SENT_REMINDER_DAYS` (90), `RETENTION_FLOW_SESSION_DAYS` (30), `RETENTION_BATCH_SIZE` (500)
- `SCHEDULED_TASKS_ENABLED`, `SCHEDULED_TASKS_ALLOWED_ROOMS`, `SCHEDULED_TASKS_MAX_RUNS_PER_DAY`, `SCHEDULED_TASKS_MAX_RUNS_PER_ROOM_PER_DAY`, `SCHEDULED_TASKS_TIMEOUT_MS`
- `DIGEST_ENABLED`, `DIGEST_MEDIA_ENABLED`, `DIGEST_HOUR_UTC`, `DIGEST_ROOMS`, `DIGEST_LOOKBACK_HOURS`, `DIGEST_MAX_MESSAGES`
- `WEBHOOK_RATE_LIMIT_MAX`, `WEBHOOK_RATE_LIMIT_WINDOW_MS`, `WEBHOOK_RATE_LIMIT_MAX_SOURCES`, `WEBHOOK_REPLAY_TTL_MS`, `WEBHOOK_REPLAY_MAX_ENTRIES`

## Inbox / Outbox delivery guarantees

Both services use SQLite row-level leasing (`LEASE_MS = 120_000`) and `MAX_ATTEMPTS = 5`:

- **Inbox**: `admit(ctx)` inserts a row keyed by `platform:event_key` (SHA-256 of `platform + chatId + messageId`). Replays of the same event return `accepted: false, reason: 'completed'` and log `Provider event already completed`. A claimed row is processed; on success it is marked `completed`, on failure `fail` increments attempts and retries with exponential backoff, dead-lettering after 5 attempts. `recoverStranded(24 h)` re-claims rows stuck in `received` or with an expired lease.
- **Outbox**: `enqueueText` / `enqueueDirectText` insert a row with an idempotency key (SHA-256 of the job parts). The 1 s worker claims up to 10 rows for operational platforms and delivers concurrently. A direct send parks the row for `DIRECT_SEND_GRACE_MS = 20_000` ms so the 1 s poller cannot claim it mid-send; the agent's own send is bounded to `DIRECT_SEND_TIMEOUT_MS` (inside the grace). Failures are recorded via `fail`, retried with backoff, dead-lettered after 5 attempts. `prune(ms)` removes terminal rows older than the media retention window.

## Scheduled agent tasks

A reminder whose text starts with `/task ` is executed as an agent turn in its room at fire time instead of being delivered as text. Off unless `SCHEDULED_TASKS_ENABLED=true` and the room is listed in `SCHEDULED_TASKS_ALLOWED_ROOMS`. The scheduler runs with the baseline `user` role only: every mutating tool is denied (`mutatingToolNames()` from the registry), and per-room/daily run ceilings apply (`SCHEDULED_TASKS_MAX_RUNS_PER_DAY`, `SCHEDULED_TASKS_MAX_RUNS_PER_ROOM_PER_DAY`, `SCHEDULED_TASKS_TIMEOUT_MS`).

## Verification

```
bun run check            # lint + typecheck + tests + db:check
bun test --no-env-file test/Scheduler.test.ts
bun test --no-env-file test/DigestService.test.ts
bun test --no-env-file test/AppRuntime.test.ts
bun test --no-env-file test/HealthMonitor.test.ts
```