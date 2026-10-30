# Spec Delta

## Purpose

Cron and countdown reminders plus scheduled agent tasks, delivered per room with allowlists, ceilings, and retry limits.

## ADDED Requirements

### Requirement: Reminder has canonical and raw room identity
Each reminder SHALL store both a canonical `room_key` and the raw provider `chat_room_id`.

#### Scenario: Reminder target resolved
- **WHEN** a reminder fires
- **THEN** delivery uses the raw provider room id resolved from the canonical key

### Requirement: Platform mismatch refused
A reminder whose canonical key addresses a different platform than the reminder's platform SHALL be refused rather than delivered.

#### Scenario: Mismatched platform retired
- **WHEN** a reminder's room key platform differs from its platform
- **THEN** the reminder is not sent and its delivery attempt count increases

### Requirement: Failed routing retired after max attempts
A reminder that cannot be routed SHALL be retired after 5 failed delivery attempts.

#### Scenario: Fifth failure retires
- **WHEN** a reminder fails to route 5 times
- **THEN** it is no longer eligible for delivery

### Requirement: Scheduled agent task marker
A reminder whose text starts with `/task ` SHALL be executed as an agent turn in its room at fire time instead of being delivered as text.

#### Scenario: Task reminder executes
- **WHEN** a reminder text begins with `/task `
- **THEN** the scheduler invokes the scheduled task runner with the instruction stripped of the marker

### Requirement: Scheduled tasks gated by feature flag
Scheduled agent tasks SHALL be disabled unless `SCHEDULED_TASKS_ENABLED=true`.

#### Scenario: Feature disabled
- **WHEN** `SCHEDULED_TASKS_ENABLED` is not `true`
- **THEN** no scheduled agent task executes

### Requirement: Scheduled tasks room allowlist
Scheduled agent tasks SHALL execute only in rooms listed in `SCHEDULED_TASKS_ALLOWED_ROOMS`.

#### Scenario: Unlisted room denied
- **WHEN** a task reminder fires in a room not on the allowlist
- **THEN** the task is not executed

### Requirement: Scheduled tasks deny mutating tools
A scheduled agent task SHALL be denied every mutating tool.

#### Scenario: Mutating tool blocked
- **WHEN** a scheduled task attempts a mutating tool
- **THEN** the tool call is denied

### Requirement: Scheduled tasks bounded by ceilings
Scheduled agent tasks SHALL be bounded by daily and per-room ceilings.

#### Scenario: Ceiling reached
- **WHEN** a room reaches its daily task ceiling
- **THEN** further scheduled tasks for that room are not executed

### Requirement: Recurring reminders persist
A reminder with a recurrence SHALL NOT be deleted after delivery; only non-recurring sent reminders are eligible for retention deletion.

#### Scenario: Recurring reminder survives
- **WHEN** a recurring reminder fires and is sent
- **THEN** the row remains for the next occurrence

### Requirement: Interval bounds
Reminder recurrence intervals SHALL be bounded between 60 seconds and 5 years.

#### Scenario: Too-short interval rejected
- **WHEN** a reminder is scheduled with an interval under 60 seconds
- **THEN** the request is rejected

### Requirement: Catch-up bounded
Catch-up for a missed recurring reminder SHALL be bounded to 400 steps.

#### Scenario: Long outage catch-up capped
- **WHEN** a recurring reminder was missed for longer than 400 intervals
- **THEN** at most 400 catch-up steps are performed

### Requirement: Stale claims recovered
A reminder claim older than 2 minutes SHALL be considered stale and recoverable.

#### Scenario: Stale claim released
- **WHEN** a reminder has been claimed for more than 2 minutes without completion
- **THEN** another worker may claim it

### Requirement: Send timeout
Each reminder delivery SHALL be bounded by a 15-second send timeout.

#### Scenario: Slow send aborted
- **WHEN** a provider send exceeds 15 seconds
- **THEN** the delivery is aborted and retried

### Requirement: Batch size limit
The scheduler SHALL process at most 50 reminders per batch.

#### Scenario: Large backlog batched
- **WHEN** more than 50 reminders are due
- **THEN** only 50 are processed in one batch
