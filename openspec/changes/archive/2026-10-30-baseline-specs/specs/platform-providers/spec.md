# Spec Delta

## Purpose

BotProvider implementations for WhatsApp, Discord, and Telegram that translate provider messages into MessageContext, manage connection lifecycle with backoff, and send provider messages using raw room IDs.

## ADDED Requirements

### Requirement: Provider contract
Each provider SHALL implement the `BotProvider` interface exposing `name`, `status`, `lastError`, `isOperational`, `start()`, `stop()`, `onMessage(handler)`, and `sendMessage(chatId, text, signal)`.

#### Scenario: WhatsApp provider name
- **WHEN** the WhatsApp provider is constructed
- **THEN** `name === 'whatsapp'`

### Requirement: Status lifecycle states
A provider's status SHALL be one of `stopped`, `starting`, `running`, `backoff`, `not_configured`, or `error`, and SHALL transition through them according to connection and configuration state.

#### Scenario: Not configured at startup
- **GIVEN** a provider with a missing or dummy token
- **WHEN** `start()` resolves
- **THEN** status is `not_configured` and no connection is attempted

#### Scenario: Reconnect after close
- **GIVEN** a provider was `running` and is `desiredRunning`
- **WHEN** the connection closes for a non-logout reason
- **THEN** status becomes `backoff` and a reconnect is scheduled

#### Scenario: Logout is terminal
- **GIVEN** WhatsApp receives DisconnectReason.loggedOut
- **WHEN** the connection closes
- **THEN** status becomes `error` and no reconnect is scheduled

### Requirement: Operational gate
`isOperational` SHALL be true only when `status === 'running'`, so the runtime only admits this provider as a sender when it can deliver.

#### Scenario: Backoff not operational
- **WHEN** status is `backoff`
- **THEN** `isOperational` is false

### Requirement: Start is idempotent and race-free
Calling `start()` while a start is in flight SHALL return the in-flight promise; concurrent starts SHALL NOT race two connections.

#### Scenario: Concurrent start deduped
- **WHEN** `start()` is called twice before the first resolves
- **THEN** the same promise is returned and only one socket is created

### Requirement: Stop cancels lifecycle
`stop()` SHALL mark the provider not-desired, bump a generation counter, abort in-flight media downloads, clear the reconnect timer, and end the socket; any in-flight start for an older generation SHALL no-op.

#### Scenario: Stopped provider aborts media
- **WHEN** `stop()` is called during a media download
- **THEN** the download's AbortController is aborted

### Requirement: Raw room id for provider I/O
`sendMessage` and all outbound provider calls SHALL use the raw provider room id (`chatRoomId`/`chatId`) and SHALL never receive a canonical room key.

#### Scenario: Outbound uses raw id
- **WHEN** the scheduler delivers a reminder
- **THEN** `sendMessage` is called with the raw provider room id

### Requirement: Reconnection backoff
Provider reconnection SHALL back off exponentially with a 2^attempts multiplier capped at 300 seconds, and SHALL reset attempts on a successful connection.

#### Scenario: Backoff capped
- **WHEN** reconnect attempts grow
- **THEN** the delay is `min(1500 * 2^attempts, 300000)` ms

### Requirement: Bot-message filtering
Providers SHALL drop messages the bot sent itself (or route them to feedback capture) so the agent does not answer its own output.

#### Scenario: Self-message dropped
- **WHEN** the provider receives a message from itself
- **THEN** no MessageContext is forwarded to the handler

### Requirement: Telegram owner seed
On Telegram connection, the bot SHALL seed its owner from `BOT_OWNER_TELEGRAM_ID` so owner-only tools are reachable even though the owner JID cannot match a numeric Telegram id.

#### Scenario: Owner seeded
- **GIVEN** `BOT_OWNER_TELEGRAM_ID` is set
- **WHEN** the Telegram bot connects
- **THEN** that user is granted the owner role