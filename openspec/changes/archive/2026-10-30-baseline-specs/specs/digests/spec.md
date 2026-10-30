# Spec Delta

## Purpose

Nightly per-room conversation summaries and weekly media rollups with exactly-once delivery.

## ADDED Requirements

### Requirement: Daily digests gated by feature flag
Nightly conversation digests SHALL run only when `DIGEST_ENABLED=true`.

#### Scenario: Feature disabled
- **WHEN** `DIGEST_ENABLED` is not `true`
- **THEN** no daily digest is produced

### Requirement: Media digests gated by feature flag
Weekly Jellyfin media rollups SHALL run only when `DIGEST_MEDIA_ENABLED=true`.

#### Scenario: Media feature disabled
- **WHEN** `DIGEST_MEDIA_ENABLED` is not `true`
- **THEN** no media rollup is produced

### Requirement: Configurable digest hour
The daily check hour SHALL be configurable from 0 to 23, defaulting to 8 UTC.

#### Scenario: Custom hour
- **WHEN** `DIGEST_HOUR_UTC=14`
- **THEN** daily checks fire at 14:00 UTC

### Requirement: Configurable digest rooms
Daily digest rooms SHALL be configurable via a comma-separated list; an empty list means no daily digests.

#### Scenario: Empty list disables daily
- **WHEN** `DIGEST_ROOMS` is empty
- **THEN** no daily digests are produced

### Requirement: Configurable lookback
Digest lookback SHALL be configurable from 1 to 720 hours, defaulting to 24.

#### Scenario: Lookback clamped
- **WHEN** `DIGEST_LOOKBACK_HOURS` is outside 1-720
- **THEN** it is clamped to the nearest bound

### Requirement: Configurable message cap
Messages fed to the LLM per digest SHALL be capped from 1 to 1000, defaulting to 500.

#### Scenario: Cap applied
- **WHEN** a room has more messages than the cap
- **THEN** only the configured maximum are fed to the LLM

### Requirement: Exactly-once daily delivery
Each room SHALL receive at most one nightly summary per UTC day, keyed by `digest:daily:<roomId>:<YYYY-MM-DD>`.

#### Scenario: Duplicate poll does not resend
- **WHEN** the daily poll runs twice for the same room and day
- **THEN** only one summary is delivered

### Requirement: Exactly-once weekly media delivery
Each room SHALL receive at most one weekly media rollup per UTC week, keyed by `digest:media:<roomId>:<weekStartDate>`.

#### Scenario: Duplicate weekly poll
- **WHEN** the weekly poll runs twice for the same room and week
- **THEN** only one rollup is delivered

### Requirement: Marker claimed before send
The marker SHALL be inserted before delivery, and only the inserter SHALL deliver.

#### Scenario: Concurrent pollers
- **WHEN** two pollers attempt the same marker simultaneously
- **THEN** only one wins the insert and delivers

### Requirement: Marker released on failure
On delivery failure the marker SHALL be deleted so the next poll retries.

#### Scenario: Failed delivery retries
- **WHEN** delivery fails after claiming the marker
- **THEN** the marker is removed and a later poll may retry

### Requirement: Weekly media rooms from subscriptions
Weekly media digest rooms SHALL be derived from `notification_subscriptions` with service type jellyfin or seerr and notify types null or containing 'digest'.

#### Scenario: Subscription filter
- **WHEN** a subscription has service type jellyfin and notify types containing 'digest'
- **THEN** its room is included in weekly media digests

### Requirement: Send timeout
Each digest delivery SHALL be bounded by a 15-second send timeout.

#### Scenario: Slow send aborted
- **WHEN** a provider send exceeds 15 seconds
- **THEN** the delivery is aborted
