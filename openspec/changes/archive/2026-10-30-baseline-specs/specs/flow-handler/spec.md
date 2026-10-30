# Spec Delta

## Purpose

Room- and user-scoped multi-step interactive flows (e.g. PDF collection) that survive restarts and detect concurrent modification via optimistic versioning.

## ADDED Requirements

### Requirement: Flow key scope
A flow session SHALL be keyed by `platform:roomId:userId` and SHALL be resolvable back to a single user within a single room/platform.

#### Scenario: Two users do not share flows
- **GIVEN** two users in the same WhatsApp group
- **WHEN** user A starts a PDF flow
- **THEN** user B's messages are not routed to A's flow

### Requirement: Active flow per room
At most one flow SHALL be active per session; `getActiveFlow` SHALL return the active flow or null, validating that the active flow's platform/room match the request.

#### Scenario: Cross-room flow ignored
- **GIVEN** a flow is active on platform W in room R-W
- **WHEN** the same user sends a message on platform D in room R-D
- **THEN** `getActiveFlow` returns null

### Requirement: Optimistic version guard
Updating a flow session SHALL carry an `expectedVersion`; if the stored version does not match, `FlowVersionConflictError` SHALL be raised and no write SHALL occur.

#### Scenario: Concurrent edit detected
- **WHEN** two workers update the same flow session simultaneously
- **THEN** the second write fails with FlowVersionConflictError

### Requirement: In-memory + DB storage
Flow sessions SHALL be cached in memory and persisted to the `flow_sessions` table; on DB read failure of a row, the corrupted row SHALL be deleted rather than crash.

#### Scenario: Corrupted row pruned
- **GIVEN** a flow_sessions row with non-object data
- **WHEN** it is read
- **THEN** it is deleted and null is returned

### Requirement: Expiry pruning
Expired flow sessions SHALL be pruned on initialization; sessions whose `expiresAt` is in the past SHALL be removed.

#### Scenario: Expired session pruned on boot
- **WHEN** the FlowHandler initializes
- **THEN** sessions with expiresAt < now are deleted

### Requirement: Cancellation
A user sending a cancel command (`cancel`, `stop`, `exit`, etc.) SHALL terminate their active flow and clear its session.

#### Scenario: Cancel ends flow
- **WHEN** a user in an active flow sends `cancel`
- **THEN** the active flow is cleared and the session saved

### Requirement: Non-blocking registration
Registering a new flow SHALL be synchronous and idempotent; the processor SHALL receive the full MessageContext and the active flow's stored data.

#### Scenario: Flow processor receives context
- **WHEN** a registered flow is active
- **THEN** the processor is invoked with (ctx, sessionData, flowId)
