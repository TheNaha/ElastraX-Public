# API & Webhooks

ElastraX runs an embedded **Bun native HTTP server** (`src/webhooks/WebhookServer.ts`) to handle inbound HTTP webhooks and platform health checks.

## Environment Variables
```env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=3500
WEBHOOK_SECRET=your_secure_random_string
```

## 1. Webhook Inbound API (`POST /webhook`)

This endpoint allows external services (like Grafana, GitHub Actions, or custom scripts) to send messages to any WhatsApp or Discord chat room.

### Authentication
The webhook server enforces security via a shared secret. You can provide the secret in one of three ways:
1. Header: `x-webhook-secret: your_secret`
2. JSON Body: `{"secret": "your_secret"}`
3. Query Parameter: `?secret=your_secret`

*Note: For GitHub webhooks, the server natively supports validation via the `X-Hub-Signature-256` HMAC header.*

### Payload Formats

**Canonical Format:**
```json
{
   "room_id": "120363xxxxxx@g.us",
   "text": "Hello from external webhook!",
   "secret": "your_secure_random_string"
}
```
*(Tip: `room_id` can also be an array `room_ids` to broadcast a message to multiple chats simultaneously).*

**Rich Alert Format (Grafana / Prometheus):**
The server attempts to parse rich fields into a beautifully formatted markdown message:
```json
{
   "room_id": "120363xxxxxx@g.us",
   "title": "Database CPU Spiking",
   "message": "The primary database cluster is above 90% CPU utilization.",
   "priority": "critical",
   "source": "Grafana Alerts",
   "tags": ["production", "database", "pager"],
   "url": "https://grafana.example.com/alert/123"
}
```

**Apprise Compatibility:**
ElastraX supports standard Apprise payload structures:
```json
{
   "room_id": "120363xxxxxx@g.us",
   "title": "Build Failed",
   "body": "CI pipeline failed on branch main.",
   "notify_type": "failure"
}
```

## 2. Healthcheck (`GET /health`)

Used by Docker and orchestration systems to verify that the bot is running and connected.
Returns a `200 OK` JSON response containing process metrics, memory usage, and the connection status of active providers (e.g., WhatsApp Socket status).
