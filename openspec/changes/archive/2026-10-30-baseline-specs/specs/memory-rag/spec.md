# Spec Delta

## Purpose

Explicit long-term fact storage scoped to sender (private) or room (group), with semantic ranking for injection into the system prompt and hard quotas on entries and bytes.

## ADDED Requirements

### Requirement: Scope determines owner
Private memories SHALL be owned by `ctx.senderId`; group memories SHALL be owned by the canonical room key, so one room never gets two owners.

#### Scenario: Group memory room-scoped
- **GIVEN** sender S in group room R
- **WHEN** S saves a group-scope memory
- **THEN** the row's ownerId equals R's canonical room key

### Requirement: Dual-read during migration
Group-scope memory reads SHALL match both the canonical room key and the legacy raw chat id so pre-migration rows remain visible.

#### Scenario: Legacy row visible
- **GIVEN** a memory owned by the legacy chat id
- **WHEN** the room now uses the canonical key
- **THEN** the memory is still returned

### Requirement: Entry and byte quotas
Storing a memory SHALL be refused when the scope already holds 500 (`MEMORY_ENTRY_QUOTA`) entries or 1,048,576 bytes (`MEMORY_BYTES_QUOTA`) of content, counting the inert marker.

#### Scenario: Entry quota refused
- **WHEN** a scope has 500 memories
- **THEN** a new save returns a quota message and no row is inserted

#### Scenario: Byte quota refused
- **WHEN** adding a memory would exceed 1 MiB
- **THEN** the save is refused

### Requirement: Per-entry content limit
A single memory's `content` SHALL be capped at 16,384 characters.

#### Scenario: Long content truncated
- **WHEN** stored content exceeds 16,384 chars
- **THEN** it is truncated to fit

### Requirement: Semantic dedup
Before insert, a near-duplicate (cosine similarity ≥ `DEDUPE_SIMILARITY_THRESHOLD`, embedding-space-matched) SHALL merge into the existing memory rather than create a new row.

#### Scenario: Duplicate merges
- **GIVEN** an existing memory with similar embedding
- **WHEN** the same fact is saved again
- **THEN** an update is performed and no new row is created

### Requirement: Consent opt-out
Once a memory is saved with `consent: false` for a given owner, subsequent saves WITHOUT explicit consent SHALL be refused for that owner.

#### Scenario: Unconsented save refused
- **GIVEN** a prior memory saved with consent=false
- **WHEN** a new save omits consent
- **THEN** the save is refused

### Requirement: Injection bounded
Per AI turn, at most 50 (`MAX_INJECTED_MEMORIES`) memories SHALL be injected as system-prompt context, most-recent-first after semantic ranking.

#### Scenario: Injection capped
- **GIVEN** a scope with 200 memories matching the query
- **WHEN** context is built for a turn
- **THEN** at most 50 are injected

### Requirement: Room knowledge bounded
Room knowledge excerpts injected per turn SHALL be capped at 4 (`MAX_ROOM_KNOWLEDGE_CHUNKS`), drawn verbatim from stored document text.

#### Scenario: Knowledge capped to 4
- **WHEN** room knowledge retrieval returns more than 4 chunks
- **THEN** only 4 are injected

### Requirement: Inert marker not interpreted
Content prefixed with `[INERT_DATA]` (or wrapped `<inert_data>`) SHALL be stored and surfaced as plain text and SHALL never be interpreted as a live instruction by the agent.

#### Scenario: Inert data returned verbatim
- **WHEN** a memory body is `<inert_data>{...}</inert_data>`
- **THEN** it is injected as-is, not parsed

### Requirement: Opt-out when embeddings disabled
When the embedding service is disabled, memory retrieval SHALL be skipped entirely and no memories SHALL be injected.

#### Scenario: Service off skips retrieval
- **GIVEN** EmbeddingService.isEnabled() is false
- **WHEN** the agent builds context
- **THEN** no memory injection occurs
