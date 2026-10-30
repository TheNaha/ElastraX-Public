# message-context Specification

## Purpose
Platform-agnostic message envelope and channel methods that the agent and tools use instead of provider APIs, so the core logic never depends on WhatsApp/Discord/Telegram specifics.

## Requirements

### Requirement: Normalized envelope
Every provider event SHALL be wrapped in a `MessageContext` exposing a common shape: `platform`, `chatId` (raw provider room id), `roomKey` (canonical), `senderId`, `senderName`, `text`, `messageId`, `isGroup`, `isBotMentioned`, `hasMedia`, and an async `mediaReady` promise.

#### Scenario: Minimal context built
- **GIVEN** a provider message arrives
- **WHEN** the provider constructs a MessageContext
- **THEN** `ctx.platform`, `ctx.chatId`, `ctx.roomKey`, and `ctx.senderId` are populated

### Requirement: Provider-specific media metadata
Platform-specific fields (mime type, file size, thumbnail, duration) SHALL be exposed as optional `MessageContext` fields (`mimeType`, `fileSize`, `mediaPath`, `mediaAttachments`) without leaking provider object shapes into core logic.

#### Scenario: Image with mime type
- **GIVEN** an image message arrives
- **WHEN** the context is built
- **THEN** `ctx.mimeType` is set and `ctx.mediaPath` is populated by the time `mediaReady` resolves

### Requirement: Quoting preserves trusted text
When `ctx.quoted` is present, it SHALL expose `text`, `senderId`, `messageType`, `rawMessage`, and media metadata; quoted text from other users SHALL be wrapped so the AI cannot trust it as the sender's literal words.

#### Scenario: Quoted message wrapped
- **WHEN** a reply quotes another user
- **THEN** `ctx.quoted.text` is available and the agent wraps it in an untrusted-quote marker before forwarding to the model

### Requirement: Channel methods degrade gracefully
All provider channel methods (`reply`, `react`, `sendMessage`, `sendMedia`, `editMessage`, `downloadMedia`) SHALL be present on the context and SHALL not throw if the platform lacks support; unsupported calls SHALL resolve or reject predictably so the agent can degrade.

#### Scenario: Unsupported reaction degrades
- **GIVEN** a platform without reactions
- **WHEN** `ctx.react('👍')` is called
- **THEN** the call does not crash the agent and the failure is logged at debug level

### Requirement: Streaming primitives
When streaming is enabled, the context SHALL expose `sendMessage` returning an editable handle and `editMessage` to mutate it; platforms that cannot edit SHALL signal this by omitting `editMessage` so the agent falls back to a single final send.

#### Scenario: Streaming fallback
- **GIVEN** a platform where `editMessage` is undefined
- **WHEN** streaming is enabled
- **THEN** the agent sends the full text once instead of incremental edits

### Requirement: Media lazy acquisition
`mediaReady` SHALL be a promise that resolves only after provider downloads complete; constructing the context SHALL NOT trigger downloads.

#### Scenario: No download on construction
- **WHEN** a MessageContext is constructed with `hasMedia: true`
- **THEN** no provider download has started until `await ctx.mediaReady`

### Requirement: Role resolution per context
`ctx.resolveRoles()` SHALL return the sender's roles in this room, and `ctx.checkPermissions(required)` SHALL answer whether the sender satisfies a required role.

#### Scenario: Owner always satisfies
- **GIVEN** a sender with the `owner` role
- **WHEN** `checkPermissions('admin')` is called
- **THEN** it resolves to true regardless of the platform

### Requirement: Abort signal propagated
If `ctx.signal` is set, the agent SHALL propagate it to provider sends and model calls so an external abort cancels in-flight work.

#### Scenario: Abort cancels send
- **WHEN** `ctx.signal` aborts during `ctx.reply`
- **THEN** the reply rejects with an AbortError
