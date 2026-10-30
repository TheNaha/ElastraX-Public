# webhook-server Specification

## Purpose
HTTP intake on a single shared listener serving health checks, metrics, admin routes, and webhook POST endpoints, with request validation, secret authentication, replay dedup, and durable enqueue that returns 202 on acceptance.

## Requirements

### Requirement: Shared listener
Webhooks, admin, health, live, ready, and metrics SHALL share one HTTP listener (default port 3500, `127.0.0.1`), with admin delegated from the webhook handler at `/admin*`.

#### Scenario: Single port multiplexed
- **WHEN** the app boots
- **THEN** `GET /health` returns 200, `POST /webhook` is accepted, and `GET /admin` is routed to the admin handler on the same port

### Requirement: Webhook enabled gate
Webhook POST endpoints SHALL be disabled when `WEBHOOK_ENABLED=false`; a disabled server SHALL still serve health and admin routes.

#### Scenario: Disabled webhook returns 503
- **WHEN** `WEBHOOK_ENABLED=false` and a POST /webhook arrives
- **THEN** it returns 503 'Webhook intake is disabled'

### Requirement: JSON content negotiation
POST endpoints SHALL require `Content-Type: application/json` and SHALL reject any other content type with 415.

#### Scenario: Non-JSON rejected
- **WHEN** a POST /webhook arrives with text/plain
- **THEN** it returns 415

### Requirement: Body size and read limits
The request body SHALL be read with a declared-content-length check, a hard byte cap (`WEBHOOK_MAX_BODY_BYTES`, default 256 KiB, max 10 MiB), and a read timeout (`WEBHOOK_BODY_READ_TIMEOUT_MS`, default 5 s). Oversize or slow bodies SHALL return 413 or 408.

#### Scenario: Oversized body rejected
- **WHEN** a body exceeds the byte cap
- **THEN** it returns 413

### Requirement: Shared secret authentication
Generic webhooks SHALL require the `WEBHOOK_SECRET` via the `x-webhook-secret` header (or `?secret=` query parameter during the compatibility window) and SHALL compare it with a constant-time compare.

#### Scenario: Constant-time compare
- **WHEN** a webhook presents the secret
- **THEN** comparison uses `timingSafeEqual`

### Requirement: Service-specific secrets
Seerr webhooks SHALL require `SEERR_WEBHOOK_SECRET` and Jellyfin webhooks SHALL require `JELLYFIN_WEBHOOK_SECRET`.

#### Scenario: Seerr secret
- **WHEN** `POST /webhook/seerr` lacks `SEERR_WEBHOOK_SECRET`
- **THEN** it returns 503

### Requirement: GitHub signature verification
GitHub webhooks SHALL verify the `x-hub-signature-256` HMAC-SHA256 against `WEBHOOK_SECRET`.

#### Scenario: Bad GitHub signature
- **GIVEN** a GitHub event with a signature that does not verify
- **WHEN** it is received
- **THEN** it returns 401

### Requirement: Replay dedup
Successful delivery SHALL reserve a replay cache entry (by event id) on receipt and complete it on success; duplicate replays SHALL return 202 with `status: 'duplicate'` without re-delivering.

#### Scenario: Replay deduped
- **GIVEN** a previously-delivered event id
- **WHEN** the same id is received again
- **THEN** the response is `{ status: 'duplicate' }`

### Requirement: Destination count cap
A request SHALL address at most `WEBHOOK_MAX_DESTINATIONS` (default 25) rooms; more SHALL return 400.

#### Scenario: Too many destinations
- **WHEN** a request names more than 25 rooms
- **THEN** it returns 400

### Requirement: 202 on durable acceptance
When a job is durably enqueued (and not a duplicate), the intake SHALL return 202 with the delivery id; only enqueue-level failures SHALL return 503.

#### Scenario: Queued returns 202
- **WHEN** a webhook is accepted and enqueued
- **THEN** the response is 202 with a deliveryId

### Requirement: Rate limiting
Intake SHALL apply per-source rate limiting (`WEBHOOK_RATE_LIMIT_MAX` per `WEBHOOK_RATE_LIMIT_WINDOW_MS` per source, up to `WEBHOOK_RATE_LIMIT_MAX_SOURCES` tracked sources).

#### Scenario: Rate limited
- **WHEN** a source exceeds its request cap
- **THEN** it receives a 429

### Requirement: Readiness explains partial failure
The readiness probe SHALL report `ready: false` with a `details` object naming the failed component, rather than a bare 503.

#### Scenario: Discord down reported
- **GIVEN** the Discord provider is not connected
- **WHEN** `/ready` is called
- **THEN** it returns 503 with `{"details": {"discord":"not operational"}}`
