# inbox-outbox Specification

## Purpose
At-least-once durable delivery for inbound provider events and outbound replies, with deduplication, leasing, retry, and stranded recovery.

## Requirements

### Requirement: Inbound deduplication by event key
Admitting the same provider event twice SHALL return `accepted: false` with reason `duplicate`, `completed`, or `dead_letter`; only the first admission SHALL be `accepted: true`.

#### Scenario: First admission accepted
- **WHEN** a new provider event is admitted
- **THEN** admission returns `accepted: true` and a new inbox row is created

#### Scenario: Replay returns completed
- **WHEN** an already-completed event is admitted again
- **THEN** admission returns `accepted: false` with reason `completed`

### Requirement: Inbox admission carries both room identities
An admitted inbox row SHALL store the canonical `room_key` alongside the raw `chat_room_id`.

#### Scenario: Admission result fields
- **WHEN** `InboxService.admit` succeeds
- **THEN** the result includes both `roomKey` and `chatRoomId`

### Requirement: Inbox claim uses a lease
Claiming an inbox row SHALL atomically move `received`/`failed` rows (or `processing` rows whose lease expired) to `processing`, increment `attempt_count`, and set a 120-second lease, only when `available_at <= now`.

#### Scenario: Expired lease reclaimed
- **WHEN** a processing row's lease has expired
- **THEN** a claim attempt succeeds and the row returns to `processing` with a new lease

### Requirement: Completion requires matching owner
Completing an inbox row SHALL succeed only when the row is `processing` with a matching `lease_owner`.

#### Scenario: Wrong owner cannot complete
- **WHEN** a different owner calls complete on a processing row
- **THEN** complete returns false and the row remains processing

### Requirement: Failure escalates after max attempts
Failing an inbox row SHALL mark it `dead_letter` when `attempt_count >= 5`, otherwise `failed` with an exponentially backed-off `available_at`.

#### Scenario: Fifth failure dead-letters
- **WHEN** a row fails for the fifth time
- **THEN** its state becomes `dead_letter`

### Requirement: Unclaimed rows can be deferred
Deferring an unclaimed inbox row SHALL mark it `dead_letter` if `attempt_count + 1 >= 5`, otherwise `failed` with a delay.

#### Scenario: Deferred never-claimed row
- **WHEN** `deferUnclaimed` is called on a received row
- **THEN** the row becomes failed or dead_letter based on attempt count

### Requirement: Stranded recovery
Recovering stranded inbox rows SHALL mark `received` rows older than the cutoff as `failed`, and return expired-lease `processing` rows to `received`.

#### Scenario: Expired processing row recovered
- **WHEN** a processing row's lease has expired
- **THEN** recovery moves it back to `received`

### Requirement: Outbound idempotency
Enqueuing outbound text with the same `(platform, idempotency_key)` SHALL NOT create a duplicate row and SHALL return the existing row's id.

#### Scenario: Duplicate enqueue returns existing id
- **WHEN** the same key parts are enqueued twice
- **THEN** both calls return the same outbox id

### Requirement: Safe text truncation
Normalizing outbound text SHALL truncate at a character boundary so no multi-byte UTF-8 sequence is split, and SHALL append a truncation marker when truncated.

#### Scenario: Multi-byte text not corrupted
- **WHEN** text exceeds the byte limit mid-character
- **THEN** the output contains no replacement character at the cut point

### Requirement: Text size limit
Outbound text SHALL be limited to 100,000 bytes UTF-8.

#### Scenario: Oversized text truncated
- **WHEN** text exceeds 100,000 bytes
- **THEN** the stored payload is at most 100,000 bytes plus the truncation marker

### Requirement: Direct-send grace period
An enqueued outbound row SHALL be parked unavailable for 20 seconds so the poller cannot duplicate an in-flight direct send.

#### Scenario: Row not immediately claimable
- **WHEN** text is enqueued with default options
- **THEN** `available_at` is at least 20 seconds in the future

### Requirement: Outbound claim returns raw room id
A claimed outbox message SHALL carry the raw provider room id as `chatRoomId` for delivery.

#### Scenario: Provider receives raw id
- **WHEN** an outbox row is claimed
- **THEN** the claimed message's `chatRoomId` is the raw provider room id
