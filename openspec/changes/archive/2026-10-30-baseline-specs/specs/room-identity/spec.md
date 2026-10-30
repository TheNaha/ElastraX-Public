# Spec Delta

## Purpose

Canonical platform-scoped room identity so durable bot state never collides across platforms while provider I/O keeps using raw room IDs.

## ADDED Requirements

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

### Requirement: Queries prefer room_key with legacy fallback
Agent, tool, and history queries SHALL prefer `room_key` and fall back to the legacy room ID during the migration window.

#### Scenario: Pre-migration row still visible
- **WHEN** a room has only a legacy row with no `room_key`
- **THEN** room-scoped queries still return that row via the legacy id

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

### Requirement: Additive migration
The room-key migration SHALL be additive: legacy columns and rows SHALL be retained, and legacy rows SHALL keep their raw provider ID as `chat_rooms.id`.

#### Scenario: Legacy column retained
- **WHEN** migration 0022 completes
- **THEN** existing `chat_rooms.id`, `messages.chat_room_id`, and other legacy columns remain populated

### Requirement: Rollback safety
Rolling back to a pre-migration application SHALL be safe for legacy rows, and new canonical-ID rows written by v8.1 SHALL NOT be interpretable by the old application as provider room IDs.

#### Scenario: Backup before migration
- **WHEN** deploying v8.1
- **THEN** a verified database backup is taken before running migration 0022
