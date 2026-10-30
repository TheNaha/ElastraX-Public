# Spec Delta

## Purpose

Structured Pino logging with a typed error taxonomy (ProviderError, AIProtocolError, WebhookRequestError) and startup validation that fails closed on misconfiguration.

## ADDED Requirements

### Requirement: JSON logging in production, pretty in dev
In production (`NODE_ENV=production`) the logger SHALL emit raw JSON; in development it SHALL attach `pino-pretty` for human-readable single-line output. Tests (`NODE_ENV=test` / `VITEST`/`BUN_TEST`) SHALL use raw JSON.

#### Scenario: Production JSON
- **WHEN** `NODE_ENV=production`
- **THEN** log output is one JSON object per line

### Requirement: Log level via env
The log level SHALL be controlled by `LOG_LEVEL` (trace|debug|info|warn|error|fatal), defaulting to `info`.

#### Scenario: Debug enables verbose
- **GIVEN** `LOG_LEVEL=debug`
- **WHEN** a debug-level event fires
- **THEN** it is emitted

### Requirement: Provider error taxonomy
Provider errors SHALL be instances of `ProviderError` (or subclasses `ProviderStartError`, `ProviderNotConfiguredError`, `ProviderLifecycleError`, `ProviderOperationError`) carrying `provider`, `operation`, `code`, and `retryable`.

#### Scenario: Start failure is typed
- **WHEN** WhatsApp startup fails
- **THEN** the thrown error is a `ProviderStartError` with code `START_FAILED` and `retryable=true`

#### Scenario: Retryable flag
- **GIVEN** a `NOT_CONNECTED` provider error
- **WHEN** the agent inspects it
- **THEN** `retryable` is set so callers can decide to retry

### Requirement: AI error taxonomy
AI/protocol errors SHALL be instances of `AIProtocolError` (codes: `invalid_response`, `no_choices`, `invalid_chunk`, `invalid_sse`, `sse_buffer_limit`, `empty_stream`, `incomplete_stream`, `empty_response`, `response_too_large`) or `AllProvidersOpenError`.

#### Scenario: All providers open
- **WHEN** every provider circuit is open within cooldown
- **THEN** the raised error is `AllProvidersOpenError` with the skipped provider keys

### Requirement: Webhook error taxonomy
Webhook intake errors SHALL be instances of `WebhookRequestError` carrying an HTTP status, surfaced as the response status from the intake handlers.

#### Scenario: Bad JSON body
- **WHEN** a webhook POST has invalid JSON
- **THEN** a `WebhookRequestError(400, 'Invalid JSON body')` is thrown and the client receives 400

### Requirement: Fail closed on misconfiguration
A malformed secret (stray whitespace) SHALL be a hard startup error; a too-short optional secret SHALL disable the gated surface silently and the bot SHALL keep running.

#### Scenario: Whitespace secret is fatal
- **GIVEN** `WEBHOOK_SECRET` has leading whitespace
- **WHEN** the app boots
- **THEN** it throws and exits

#### Scenario: Short metrics token is non-fatal
- **GIVEN** `METRICS_AUTH_TOKEN` is 10 bytes
- **WHEN** the app boots
- **THEN** only the dashboard/metrics surface is disabled