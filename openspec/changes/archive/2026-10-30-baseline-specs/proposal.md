# Proposal

## Why

ElastraX has 14+ durable, user-facing subsystems (room identity, inbox/outbox, scheduler, retention, digests, agent loop, ...) documented in docs/ and enforced by ~1500 tests, but no OpenSpec specs. Without a spec baseline, requirement drift, regressions, and "what does this system promise?" questions can only be answered by reading code. Capturing the documented behavior as specs gives every future change a contract to diff against.

## What Changes

- Introduce baseline specs for the durable capabilities listed below, derived from docs/architecture.md, docs/room-identity-migration.md, docs/api.md, and the relevant source modules. Specs state purpose, requirements, and scenarios; they do not change implementation.
- Specs are captured in batches (~4-5 capabilities per batch) so each can be reviewed for depth and accuracy before the next batch. Batch 1 (this pass): room-identity, inbox-outbox, scheduler, retention, digests.
- No code, schema, or behavior changes. This is a documentation/specification change only.

## Capabilities

### New Capabilities

- message-context: Normalized, platform-agnostic MessageContext wrapper exposing reply/react/sendMedia/downloadMedia/deleteMessage used by the agent.
- platform-providers: BotProvider implementations for WhatsApp (Baileys), Discord (discord.js), Telegram (grammy), including lifecycle and pairing.
- agent-loop: Single entry point handleIncomingMessage pipeline: flow interception, explicit commands, intent/rule checks, LLM inference, tool execution loop.
- flow-handler: Room-bound, versioned, restart-resumable multi-step interactive flows (e.g. PDF collection).
- room-identity: Canonical room:<platform>:<id> keys for all durable room references; ctx.chatId reserved for provider I/O.
- model-router: Multi-provider failover router with circuit breaking, lazy instantiation, and health tracking.
- memory-rag: Explicit long-term fact storage by the AI, queried and injected into the system prompt.
- inbox-outbox: At-least-once durable delivery: inbound dedup by senderId:messageId, outbound enqueue/retry, stranded recovery.
- scheduler: Cron/countdown reminders and scheduled agent tasks with allowlists and ceilings.
- retention: Dry-run-by-default deletion of terminal inbox/outbox, deliveries, sent reminders, flow sessions, old messages.
- digests: Nightly per-room conversation summaries and weekly Jellyfin rollup with exactly-once delivery via app_kv markers.
- admin-dashboard: Token-gated (>=24 bytes) read-mostly /admin dashboard with CSRF session cookies.
- logging-errors: Pino logging, ProviderError/AIProtocolError/WebhookRequestError taxonomies and startup validation.
- webhook-server: Webhook intake on the shared listener, durable enqueuer switch, 202 on durable acceptance.

### Modified Capabilities

(none - baseline capture only)

## Impact

- Affected: openspec/specs/** (new files only). No source, tests, schema, or config changes.
- Enables future changes to declare deltas against a real baseline instead of the empty spec inventory.
