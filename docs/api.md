# API and Webhooks

ElastraX exposes one Bun HTTP listener for inbound webhooks and operational endpoints. The exact route table is:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/webhook` | Generic payloads; signed GitHub payloads remain accepted here |
| `POST` | `/webhook/github` | Explicit GitHub webhook route |
| `POST` | `/webhook/seerr` | Jellyseerr/Overseerr notifications |
| `POST` | `/webhook/jellyfin` | Jellyfin notifications |
| `GET` | `/health` | Compatibility alias for minimal liveness |
| `GET` | `/live` | Minimal liveness: `{"status":"ok"}` |
| `GET` | `/ready` | Readiness compatibility hook |
| `GET` | `/metrics` | Protected Prometheus metrics |

All other paths return `404`. A known path with the wrong method returns `405` and an `Allow` header. Every POST route requires `Content-Type: application/json`; other media types return `415`.

## Authentication

Generate each shared secret with at least 24 random bytes:

```bash
openssl rand -base64 32
```

Set `WEBHOOK_SECRET` for `/webhook` and `/webhook/github`. The preferred generic authentication header is:

```http
X-Webhook-Secret: <secret>
```

`Authorization: Bearer <secret>` is also accepted. GitHub requests must instead carry a valid `X-Hub-Signature-256` HMAC. `X-GitHub-Delivery` is used for replay detection.

Media routes require independent `SEERR_WEBHOOK_SECRET` and `JELLYFIN_WEBHOOK_SECRET` values. An unset media secret fails closed with `503`; it never enables unauthenticated intake. Media requests accept `X-Webhook-Secret` or `Authorization: Bearer <secret>`.

### Bounded legacy secret locations

JSON `secret` and `?secret=` are disabled by default because bodies may be retained and proxy logs may record URLs. A migration can enable each location independently only with both an explicit boolean and a future absolute RFC3339 expiry:

```env
WEBHOOK_BODY_SECRET_COMPAT_ENABLED=true
WEBHOOK_BODY_SECRET_COMPAT_UNTIL=2026-12-31T23:59:59Z
WEBHOOK_QUERY_SECRET_COMPAT_ENABLED=true
WEBHOOK_QUERY_SECRET_COMPAT_UNTIL=2026-12-31T23:59:59Z
```

The deadline is checked for every request. Remove the compatibility variables after all senders have migrated to `X-Webhook-Secret`.

## Generic payload

```http
POST /webhook
Content-Type: application/json
X-Webhook-Secret: <secret>
X-Webhook-Id: alert-018f6f08

{
  "room_id": "120363xxxxxx@g.us",
  "title": "Production alert",
  "message": "HTTP 5xx ratio exceeded 5%",
  "priority": "critical",
  "event": "api.error_rate",
  "source": "prometheus",
  "tags": ["production", "api"],
  "url": "https://status.example.com/incidents/123"
}
```

`room_id`, `room_ids`, and their query equivalents are merged and deduplicated. Generic keys include `title`, `text|message|body|description`, `priority|severity|level`, `event|event_type`, `source|service`, `tags|tag`, and `url|link`. Unknown payloads produce a bounded field summary rather than a raw JSON dump. Authentication and common credential fields are removed before any formatter sees the payload.

Fan-out defaults to 25 destinations and is bounded by `WEBHOOK_MAX_DESTINATIONS`.

## Replay and rate limits

Send `X-Webhook-Id` or `X-Event-Id` for generic/media events. GitHub uses `X-GitHub-Delivery`. IDs are retained in a bounded in-memory cache for `WEBHOOK_REPLAY_TTL_MS`; a future durable outbox will use the same ID as its idempotency key.

`X-Webhook-Source` or the payload `source` identifies a source. Source and connection keys are independently governed by the token-bucket limits `WEBHOOK_RATE_LIMIT_MAX` and `WEBHOOK_RATE_LIMIT_WINDOW_MS`. Source length and the number of tracked rate-limit keys are bounded.

## Request bounds

The listener rejects:

- bodies over `WEBHOOK_MAX_BODY_BYTES` with `413`;
- bodies not completed within `WEBHOOK_BODY_READ_TIMEOUT_MS` with `408`;
- invalid or excess destinations with `400`;
- authenticated request bursts over the configured rate limit with `429` and `Retry-After`.

Formatted chat text is truncated to `WEBHOOK_MAX_TEXT_LENGTH`.

## Delivery responses

Without an outbox enqueuer, the current synchronous sender is preserved:

- `200 {"ok":true,"delivered":N}` when every destination succeeds;
- `207` with a bounded failed-destination list when only some sends fail.

`WebhookServer.registerEnqueuer()` provides the future durable-outbox integration and supplies an `AbortSignal` with `WEBHOOK_ENQUEUE_TIMEOUT_MS`. When registered, the server returns `202` only after the enqueuer confirms that it durably accepted the job:

```json
{
  "ok": true,
  "status": "queued",
  "duplicate": false,
  "deliveryId": "outbox-123",
  "acceptedAt": "2026-09-25T12:00:00.000Z"
}
```

A rejected enqueue returns `503`; the server never fabricates durability or falls back to an untracked send.

## Operational endpoints

`/health` and `/live` expose only process liveness. `/ready` returns `200 {"status":"ready"}` by default for compatibility. Integrations can register bounded readiness checks with `WebhookServer.registerReadinessCheck()`; any false, failed, or timed-out check produces a detail-free `503`.

Set `METRICS_AUTH_TOKEN` to enable `/metrics`. Without it the route is hidden with `404`. With it, send `Authorization: Bearer <token>` or `X-Metrics-Token`. Query-string metrics authentication is not supported.

Native startup binds `127.0.0.1` by default. See [Deployment](./deployment.md) for the loopback Compose binding and reverse-proxy example.
