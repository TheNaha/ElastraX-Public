# room-identity Specification

## Purpose
Canonical platform-scoped room identity so durable bot state never collides across platforms while provider I/O keeps using raw room IDs.

## Requirements

### Requirement: Canonical room key format
The system SHALL represent every durable room reference as a canonical key of the form `room:<platform>:<remoteRoomId>`.

#### Scenario: WhatsApp group key
- **WHEN** a message arrives in WhatsApp group `12025550123@g.us`
- **THEN** the canonical room key is `room:whatsapp:12025550123@g.us`

#### Scenario: Discord channel key
- **WHEN** a message arrives in Discord channel `123456789012345678`
- **THEN** the canonical room key is `room:discord:123456789012345678`

### Requirement: chatId reserved for provider I/O
`ctx.chatId` SHALL be the raw provider room ID used only for provider I/O, and `ctx.roomKey` SHALL be the canonical database identity.

#### Scenario: Outbound send uses raw id
- **WHEN** the bot sends a reply to a room
- **THEN** the provider receives `ctx.chatId` and never `ctx.roomKey`

### Requirement: Durable dispatch uses room_key
`message_inbox.room_key`, `message_outbox.room_key`, and any scheduled-delivery `room_key` SHALL be the durable dispatch identities.

#### Scenario: Inbox row carries canonical key
- **WHEN** a provider event is admitted
- **THEN** the inbox row stores the canonical `room_key` alongside the raw `chat_room_id`

### Requirement: Queries use canonical room key only
Agent, tool, and history queries SHALL read the canonical `room_key` column only. There is no legacy `chat_room_id` fallback.

#### Scenario: Canonical key row visible
- **WHEN** a room-scoped query targets `room:whatsapp:12025550123@g.us`
- **THEN** the query matches the row whose `room_key` equals that key

#### Scenario: Legacy-only row not returned
- **WHEN** a room row has a `chat_room_id` but a NULL `room_key`
- **THEN** room-scoped queries do not return that row

### Requirement: Workers refuse canonical to providers
Inbox and outbox workers SHALL NOT send a canonical key to a provider; the provider SHALL receive the original remote room ID.

#### Scenario: Outbox claim returns raw id
- **WHEN** an outbox row is claimed for delivery
- **THEN** the claimed message's `chatRoomId` is the raw provider room id

### Requirement: Webhooks resolve to canonical before enqueue
Webhook destinations SHALL be resolved to a canonical room key before durable enqueue, while the provider receives the original remote ID.

#### Scenario: Webhook destination canonicalized
- **WHEN** a webhook targets a room
- **THEN** the enqueued outbox row stores the canonical `room_key` and the raw remote id is retained for delivery

### Requirement: Migration 0022 columns are required
Migration 0022's `room_key` columns on `chat_rooms`, `messages`, `reminders`, `notification_subscriptions`, `message_inbox`, `message_outbox`, `user_roles`, and `flow_sessions` are always populated for every room row. The canonical `room_key` is `chat_rooms.id` on insert.

#### Scenario: Every chat room has a room key
- **WHEN** migration 0022 has completed and rooms exist
- **THEN** every `chat_rooms` row has a non-NULL `room_key`

#### Scenario: New room insert uses canonical key as id
- **WHEN** a new room row is created
- **THEN** `chat_rooms.id` is the canonical `room_key`
