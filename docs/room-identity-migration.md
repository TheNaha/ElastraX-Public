# Canonical Room Identity Migration

ElastraX `v8.1.0` introduces a platform-scoped canonical room key:

```text
room:<platform>:<remoteRoomId>
```

Examples:

```text
room:whatsapp:12025550123@g.us
room:discord:123456789012345678
```

## Why this exists

Provider room IDs are only unique inside a platform. A WhatsApp JID and a Discord channel ID may have the same raw value. All durable bot state therefore needs a canonical internal identity, while provider I/O continues to use the raw provider ID.

## Storage model

Migration `0022_room_keys` adds:

- `room_keys`: canonical key, platform, raw provider room ID, and optional legacy room ID.
- `room_key_conflicts`: deterministic audit records for unresolved or ambiguous data.
- Nullable `room_key` columns on rooms, messages, reminders, subscriptions, inbox, outbox, scheduled deliveries, flows, and roles.
- `user_roles.scope_room_key` for canonical room scopes.
- Covering indexes and partial unique indexes for canonical room rows and room-scoped subscriptions.

The migration is additive. Existing `chat_rooms.id`, `messages.chat_room_id`, and other legacy columns are retained. Legacy rows keep their raw provider ID as `chat_rooms.id`; new rows may use the canonical key as the internal primary key, with the raw ID stored in `room_keys`.

## Runtime contract

- `ctx.chatId` is the raw provider room ID and is the only value sent to providers.
- `ctx.roomKey` is the canonical database identity.
- `message_inbox.room_key`, `message_outbox.room_key`, and `scheduled_deliveries.room_key` are the durable dispatch identities.
- Agent/tools/history queries prefer `room_key` and fall back to the legacy room ID during the migration window.
- Inbox/outbox workers refuse to send a canonical key to a provider.
- Webhook destinations are resolved to a canonical key before durable enqueue, while the provider receives the original remote ID.

## Rollout

1. Stop the single bot instance.
2. Run `db:preflight` on a restored copy.
3. Run the migration and `bun run db:room-keys` in read-only mode.
4. Verify zero unresolved conflicts and complete room-key coverage.
5. Start one canary instance and run provider, webhook, restart, and history-sync checks.
6. Deploy the same migration artifact to the remaining instance only after the canary passes.
7. Keep the legacy columns and read fallback for at least one release.
8. Drop legacy compatibility only in a later, separately verified migration.

## Rollback

A rollback to a pre-0022 application is safe for existing legacy rows, but new canonical-ID rows written by v8.1 cannot be interpreted by the old application as provider room IDs. Therefore:

- Always take a verified backup before the v8.1 migration.
- Roll back the application and restore the matching pre-migration database when canonical-ID rooms have been created.
- Do not run the old binary against a v8.1 database containing new canonical-ID rows without restoring or down-migrating those rows.
- Never delete the legacy database or WhatsApp auth backup during rollback validation.

## Verification

The focused room-key tests cover:

- Fresh 0021 upgrade.
- Populated pre-0022 upgrade.
- Deterministic backfill and idempotency.
- Same remote ID on two platforms.
- Legacy-only and dual-read rows.
- Canonical webhook destinations.
- Raw provider delivery targets.
- Room-scoped roles, history, reminders, subscriptions, inbox, and outbox isolation.

Run:

```sh
bun run db:check
bun run db:room-keys
bun run test:hermetic
bun run test:isolated
```

`db:room-keys` is read-only by default. It refuses to fall back to a writable database connection if the live WAL cannot be opened consistently.
