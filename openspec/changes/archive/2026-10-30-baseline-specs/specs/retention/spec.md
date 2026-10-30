# Spec Delta

## Purpose

Dry-run-by-default retention that purges stale messages, reminders, deliveries, and flow sessions with bounded batches.

## ADDED Requirements

### Requirement: Dry run by default
Retention SHALL default to dry-run mode, reporting counts without deleting rows.

#### Scenario: Default invocation
- **WHEN** retention runs without explicit options
- **THEN** `dryRun` is true and no rows are deleted

### Requirement: Explicit apply
Retention SHALL delete rows only when `dryRun` is false.

#### Scenario: Apply mode
- **WHEN** retention runs with `dryRun: false`
- **THEN** matching rows are deleted and counts returned

### Requirement: Batched deletion
Each deletion target SHALL be processed in batches no larger than 10,000 rows, defaulting to 500.

#### Scenario: Large table batched
- **WHEN** more than the batch size of rows match
- **THEN** deletion proceeds in multiple batches

### Requirement: Raw message clearing after 7 days
Raw message payloads and media paths SHALL be cleared for messages older than 7 days.

#### Scenario: Old raw payload cleared
- **WHEN** a message is older than 7 days and has a raw payload
- **THEN** `raw_message`, `media_path`, and `mime_type` are set to null

### Requirement: Message deletion grace
Messages SHALL be deleted only when older than `messagesDays + messageDeleteGraceDays` days, defaulting to 180 + 30.

#### Scenario: Recent message retained
- **WHEN** a message is younger than the combined threshold
- **THEN** it is not deleted

### Requirement: Sent reminder deletion
Non-recurring sent reminders SHALL be deleted when older than `sentRemindersDays` days, defaulting to 90.

#### Scenario: Old sent reminder removed
- **WHEN** a sent non-recurring reminder is older than 90 days
- **THEN** it is deleted

#### Scenario: Recurring reminder retained
- **WHEN** a sent reminder has a recurrence
- **THEN** it is never deleted by retention

### Requirement: Terminal delivery deletion
Terminal inbox and outbox rows (completed/dead_letter, sent/dead_letter) SHALL be deleted when older than `terminalDeliveriesDays` days, defaulting to 90.

#### Scenario: Old completed inbox removed
- **WHEN** a completed inbox row is older than 90 days
- **THEN** it is deleted

### Requirement: Stale delivery deletion
Non-terminal inbox and outbox rows older than `terminalDeliveriesDays` days SHALL be deleted as stale.

#### Scenario: Stuck pending outbox removed
- **WHEN** an outbox row stays pending longer than 90 days
- **THEN** it is deleted

### Requirement: Flow session deletion
Flow sessions SHALL be deleted when older than `expiredFlowSessionsDays` days, defaulting to 30.

#### Scenario: Old flow session removed
- **WHEN** a flow session is older than 30 days
- **THEN** it is deleted

### Requirement: Table name whitelist
Retention SQL SHALL only target whitelisted table names to prevent injection.

#### Scenario: Unknown table rejected
- **WHEN** an unknown table name is supplied
- **THEN** retention throws an error

### Requirement: Optimization on apply
When not in dry-run mode, retention SHALL run `PRAGMA optimize` and optionally `VACUUM`.

#### Scenario: Vacuum on request
- **WHEN** retention runs with `vacuum: true` in apply mode
- **THEN** `VACUUM` is executed
