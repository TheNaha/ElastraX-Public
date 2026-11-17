# Background Services

ElastraX runs several long-lived services and timers inside the single bot process. They are owned by `src/runtime/AppRuntime.ts`, which starts them after providers connect and stops them gracefully on shutdown. All interval timers are `unref()`'d so they do not keep the process alive on their own.

## Service list

| Service | File | What it does |
|---|---|---|
| AppRuntime | `src/runtime/AppRuntime.ts` | Process-level coordinator: starts providers, message queue, scheduler, digest service, webhook server, health monitor, and all background timers. |
| MessageQueue | `src/utils/MessageQueue.ts` | Per-room bounded queue for inbound message handling; serializes work per room, bounds global pending work, supports shutdown drain. |
| Scheduler | `src/utils/Scheduler.ts` | Cron/countdown reminders from the `reminders` table; drives scheduled agent tasks (`/task ` marker). Polls every 30 s. |
| DigestService | `src/utils/DigestService.ts` | Nightly per-room conversation summaries + weekly Jellyfin "new media" rollup; exactly-once delivery via `app_kv` markers, with at most 3 delivery attempts per day/week before the marker is kept until the next period. Markers older than 30 days are pruned. Polls every 60 s. |
| HealthMonitor | `src/utils/HealthMonitor.ts` | Pings Jellyfin, Seerr, each configured LLM provider, and yt-dlp every 60 s; records service health in `HealthMetrics`. |
| InboxService | `src/messaging/InboxService.ts` | At-least-once inbound deduplication: admits provider events into `message_inbox`, dedupes by `platform:event_key`, leases rows for 120 s, dead-letters after 5 attempts. `recoverStranded` fails never-claimed rows and re-queues expired-lease `processing` rows. |
| OutboxService | `src/messaging/OutboxService.ts` | Durable outbound delivery: enqueues replies/reminders/webhook messages, claims and delivers with retries and exponential backoff, dead-letters after 5 attempts. |
| MediaService | `src/utils/MediaService.ts` | Jellyfin client for media rollups and watch links. |
| NotificationSubscriptionService | `src/utils/NotificationSubscriptionService.ts` | Room-level notification subscriptions (seerr/jellyfin, notify types). |
| ConfigService | `src/utils/ConfigService.ts` | Per-room resolved config: system prompt, context limit, temperature, allow tools, auto-reply-all, summarize, long-term memory. |
| ConversationSummarizer | `src/utils/ConversationSummarizer.ts` (persisted via `src/ai/summaryStore.ts`) | Rolls history past the context window into a per-room summary so it need not be re-sent; watermark lives in `app_kv`, and an overflow below the batch threshold is widened back into the active window instead of dropped. |
| AuthService | `src/utils/AuthService.ts` | Role and privilege resolution for senders; merges DB roles with role defaults. |
| IdentityService | `src/utils/IdentityService.ts` | Canonical user identity: LID/pn alias resolution and merge of a legacy identity into the canonical one. |
| ServiceBindingService | `src/utils/ServiceBindingService.ts` | CRUD for external account bindings (Jellyfin, Seerr) used by the binding-gated media tools. |
| EmbeddingService | `src/utils/EmbeddingService.ts` | Semantic memory embeddings and near-duplicate suppression (OpenAI-compatible embeddings endpoint). |
| MediaCleanup | `src/utils/MediaCleanup.ts` | Deletes cached media files older than `MEDIA_RETENTION_HOURS`; runs on startup and every `MEDIA_CLEANUP_INTERVAL_MS`. |
| RateLimiter | `src/utils/RateLimiter.ts` | Token-bucket rate limiting per sender/platform; pruned every 10 minutes. |
| FlowHandler | `src/core/FlowHandler.ts` | Interactive multi-step flow state machine in SQLite; TTL-pruned every hour. |

## AppRuntime lifecycle

`src/runtime/AppRuntime.ts` is the process coordinator. Its `start()` sequence:

1. Wait for the tool registry (`registryReady`) so slash commands and LLM tool lookups never hit an empty registry.
2. Register all flow processors via `safeRegisterFlows()`.
3. Register `onMessage` handlers on every provider.
4. Start all providers via `Promise.allSettled`. A provider that fails to start is logged and skipped (degraded mode). Admission to `activeProviders` is based on `start()` *resolving*, not on `isOperational`: WhatsApp only reports `running` from its socket `open` handler, which fires after `start()` returns. A provider whose `start()` rejected while it scheduled its own reconnect is not in that boot snapshot; `reconcileProviderAdmission()` wires its senders (and appends it to `activeProviders`) as soon as it becomes operational, and runs on every outbox tick and webhook enqueue. `operationalProviders()` reads `isOperational` live across the full provider list, so the delivery lanes self-heal without a restart.
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
| Retention maintenance | startup + 24 h (durable store only) | `runRetentionMaintenance` (dry-run unless `RETENTION_DRY_RUN=false`) |
| Startup coverage scan | once, 5 s after boot | `runStartupCoverageScan` over at most 2 000 stored messages; wired by the default bootstrap and non-fatal on error |
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

- **Inbox**: `admit(ctx)` inserts a row keyed by `platform:event_key` (SHA-256 of `platform + chatId + messageId`). Replays of the same event return `accepted: false, reason: 'completed'` and log `Provider event already completed`. A claimed row is processed; on success it is marked `completed`, on failure `fail` increments attempts and retries with exponential backoff, dead-lettering after 5 attempts. `recoverStranded(24 h)` marks never-claimed `received` rows as `failed` and returns expired-lease `processing` rows to `received` (dead-lettering those at `MAX_ATTEMPTS`).
- **Outbox**: `enqueueText` / `enqueueDirectText` insert a row with an idempotency key (SHA-256 of the platform and job parts), or update it in place when the same key is enqueued again while the row is still `pending`/`failed` — the payload is replaced, `available_at` moves to the later of the two values, and `attempt_count`/`last_error` are reset, so a re-run of an event does not inherit the previous run's attempt budget. The 1 s worker claims up to 10 rows for operational platforms and delivers concurrently. A direct send parks the row for `DIRECT_SEND_GRACE_MS = 20_000` ms so the 1 s poller cannot claim it mid-send; the agent's own send is bounded to `DIRECT_SEND_TIMEOUT_MS = DIRECT_SEND_GRACE_MS − 2 × CLOCK_SKEW_BUFFER_MS = 10,000` ms, which keeps the abort ahead of the tick that would claim the row. `recordTextDelivered` promotes an existing non-`sent` row to `sent`, so a reply delivered by the streaming path cannot be claimed and sent a second time. Failures are recorded via `fail`, retried with backoff, dead-lettered after 5 attempts. `prune(ms)` removes terminal rows older than the media retention window.

## Scheduled agent tasks

A reminder whose text starts with `/task ` is executed as an agent turn in its room at fire time instead of being delivered as text. Off unless `SCHEDULED_TASKS_ENABLED=true` and the room is listed in `SCHEDULED_TASKS_ALLOWED_ROOMS`. The scheduler runs with the baseline `user` role only: every mutating tool is denied (`mutatingToolNames()` from the registry), and per-room/daily run ceilings apply (`SCHEDULED_TASKS_MAX_RUNS_PER_DAY`, `SCHEDULED_TASKS_MAX_RUNS_PER_ROOM_PER_DAY`, `SCHEDULED_TASKS_TIMEOUT_MS`).

## Reminder delivery and retries

`Scheduler.processReminders` runs every 30 s and claims at most 50 due rows per tick. A row is claimed by writing `reminders.claimed_at`; the claim is the only reselection gate, so a reminder is never processed twice concurrently.

- **At-most-once claim, with a safe stale window.** The stale-claim window is `max(2 min, SCHEDULED_TASKS_TIMEOUT_MS)`. A tick that overlaps a still-running scheduled task (which may legitimately run for up to 15 min) therefore cannot steal the claim and send a duplicate.
- **Send failure.** Retries use attempt-aware exponential backoff (30 s base, exponent capped at 7) and stop after `MAX_DELIVERY_ATTEMPTS = 5`, which retires the reminder with an error log. The retry is paced through `claimed_at`, not `remindAt`.
- **Deferral (no sender for the platform).** When a provider is in degraded mode or absent, delivery cannot even be attempted. This is tracked in a separate counter with `MAX_DEFER_ATTEMPTS = 24` and a backoff capped at 1 h. A recurring reminder is **never** retired by this path; its next occurrence is the retry.
- **Recurring schedules keep their anchor.** On failure and deferral, `remindAt` is left alone for recurring rows, so a transient error cannot re-base a 09:00 daily reminder to the retry time. The monthly cadence is anchored to `reminders.anchor_day`, captured from the first fire date when the reminder is created, because `remind_at` afterwards holds the *clamped* date (Jan 31 → Feb 28) and `created_at` is unrelated to it. A 31st-of-month reminder therefore fires on the 28th/30th only in a shorter month and returns to the 31st. Rows written before the column existed fall back to `created_at`'s day-of-month.
- **Permanent failures retire immediately.** A `room_key`/`chat_room_id` mismatch or an unparsable recurrence retires the row on first sight instead of retrying forever.
- In-memory attempt counters are cleared when the row succeeds or is deleted.

## Verification

```
bun run check            # lint + typecheck + tests + db:check
bun test --no-env-file test/Scheduler.test.ts
bun test --no-env-file test/DigestService.test.ts
bun test --no-env-file test/AppRuntime.test.ts
bun test --no-env-file test/HealthMonitor.test.ts
```