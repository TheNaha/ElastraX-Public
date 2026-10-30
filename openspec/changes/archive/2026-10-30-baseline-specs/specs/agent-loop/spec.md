# Spec Delta

## Purpose

The single per-message pipeline that decides whether to reply, runs flows, dispatches commands, and drives the LLM+tool loop with role-based rate limits and context ceilings.

## ADDED Requirements

### Requirement: Single entry point
All messages from all providers SHALL enter the agent through `handleIncomingMessage`, which resolves the room and roles before any branching.

#### Scenario: Room resolved first
- **WHEN** `handleIncomingMessage` returns
- **THEN** a chat room row exists and `ctx.roomKey` matches it

### Requirement: Reply decision matrix
The agent SHALL reply when (a) the room is a private DM, (b) the room has `autoReplyAll`, (c) the message is a slash command, (d) the bot is mentioned, or (e) the sender replied to a bot message; otherwise it SHALL NOT reply in groups.

#### Scenario: Casual group mention ignored
- **GIVEN** a public group room without autoReplyAll
- **WHEN** a user sends a message not mentioning the bot and not starting with `/`
- **THEN** the bot does not reply

#### Scenario: Casual group reply to bot
- **WHEN** a user replies to a message sent by the bot
- **THEN** the bot replies

### Requirement: Flow interception before commands
Active interactive flows SHALL be checked and handled before command dispatch and AI inference; an in-flow message SHALL short-circuit the rest of the pipeline.

#### Scenario: Flow consumes input
- **GIVEN** the user has an active multi-step flow
- **WHEN** a message arrives
- **THEN** the flow processor receives it and no AI reply is generated

### Requirement: Explicit commands bypass the LLM
Messages starting with `/` (and not the `/chat` marker) SHALL be routed to the matching authorized tool directly, without LLM involvement.

#### Scenario: Command does not invoke model
- **WHEN** `/ping` is received
- **THEN** the PingTool runs and no chatCompletion call is made

### Requirement: Role-based rate limiting
Before AI inference, the sender's per-role rate limit SHALL be checked; if exceeded, the agent SHALL reply with a rate-limited notice and not consume the turn.

#### Scenario: Rate-limited user rejected
- **GIVEN** a `user` role with maxMessagesPerWindow reached
- **WHEN** a new message arrives
- **THEN** the sender receives the rate-limit notice and no LLM call is made

#### Scenario: Owner rate-unlimited
- **GIVEN** the sender holds `owner`
- **WHEN** the role's `maxMessagesPerWindow` is `-1`
- **THEN** the rate limiter is skipped

### Requirement: Context ceiling composes room and role
The effective context window SHALL be the minimum of the room's `contextLimit` and the caller role's `contextLimit` ceiling; `-1` denotes unlimited.

#### Scenario: Role ceiling caps room request
- **GIVEN** the room requests 500 messages but the caller's role ceiling is 20
- **WHEN** context is fetched
- **THEN** at most 20 messages are loaded

### Requirement: Tool loop bounded
Tool-call iteration SHALL be capped at `AI_MAX_TOOL_ITERATIONS` (default 8) to prevent unbounded recursion from a tool that keeps requesting more calls.

#### Scenario: Loop cap
- **WHEN** the model requests more than 8 tool iterations
- **THEN** the loop stops and returns the current best answer

### Requirement: Durable reply on send failure
If immediate provider delivery fails, the agent SHALL keep the text in the outbox for retry and still persist the assistant message locally.

#### Scenario: Outbox fallback
- **WHEN** `ctx.reply` throws
- **THEN** the text is enqueued in `message_outbox` and the assistant message is persisted

### Requirement: Fatal error surfaces localized text
Any uncaught agent error SHALL be logged, reacted to with `❌`, and the sender SHALL receive the `agent.internal_error` localized string via the durable outbox.

#### Scenario: Uncaught error handled
- **WHEN** `handleIncomingMessage` throws
- **THEN** the sender receives the internal-error text and a `❌` reaction
