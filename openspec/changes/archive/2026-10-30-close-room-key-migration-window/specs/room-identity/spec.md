# room-identity Specification (delta)

## Purpose
Delta spec for closing the room-key migration window: the canonical platform-scoped room key `room:<platform>:<remoteRoomId>` is now the only readable room identity; the legacy `chat_room_id` fallback is removed.

This delta modifies `openspec/specs/room-identity/spec.md`. Changes apply to observable behavior only; implementation details are out of scope.

## Changes to existing requirements

### Change: Queries use canonical room key only
Previously: Agent, tool, and history queries SHALL prefer `room_key` and fall back to the legacy room ID during the migration window.

Now: Agent, tool, and history queries SHALL read the canonical `room_key` column only. There is no legacy `chat_room_id` fallback.

#### Scenario: Canonical key row visible
- **WHEN** a room-scoped query targets `room:whatsapp:12025550123@g.us`
- **THEN** the query matches the row whose `room_key` equals that key

#### Scenario: Legacy-only row not returned
- **WHEN** a room row has a `chat_room_id` but a NULL `room_key`
- **THEN** room-scoped queries do not return that row

### Change: Migration 0022 columns are required, not optional
Previously: Migration 0022 was additive and additive-only; legacy columns remained populated and new rows could keep the raw provider ID as `chat_rooms.id`.

Now: Migration 0022's `room_key` columns on `chat_rooms`, `messages`, `reminders`, `notification_subscriptions`, `message_inbox`, `message_outbox`, `user_roles`, and `flow_sessions` are always populated for every room row. The canonical `room_key` is `chat_rooms.id` on insert.

#### Scenario: Every chat room has a room key
- **WHEN** migration 0022 has completed and rooms exist
- **THEN** every `chat_rooms` row has a non-NULL `room_key` equal to `room:<platform>:<remoteRoomId>`

#### Scenario: New room insert uses canonical key as id
- **WHEN** a new room row is created
- **THEN** `chat_rooms.id` is the canonical `room_key`

### Change: No rollback to pre-0022 application
Previously: Rolling back to a pre-migration application was safe for legacy rows.

Now: Rolling back to an application that reads only legacy `chat_room_id` columns is not supported once the window closes. Databases must remain on migration `0022` or later.

### Unchanged requirements

- Canonical room key format (`room:<platform>:<remoteRoomId>`).
- `ctx.chatId` reserved for provider I/O only; `ctx.roomKey` is the canonical database identity.
- Durable dispatch uses `room_key` (`message_inbox.room_key`, `message_outbox.room_key`, scheduled deliveries).
- Workers refuse to send canonical keys to providers.
- Webhooks resolve to canonical before enqueue.

## Removed requirements

- "Queries prefer room_key with legacy fallback" (replaced by canonical-key-only above).
- "Additive migration" as a rollback-safe, legacy-column-retaining contract (replaced by required `room_key` columns above).
- "Rollback safety" (no longer supported).
