# Setup

## 1. Install the supported runtime

Install Bun `1.3.14` and verify it:

```bash
bun --version
```

Use `bun.lock` for all dependency operations. Do not mix npm or another package manager into the release path.

```bash
bun install --frozen-lockfile
```

FFmpeg and yt-dlp are optional for text-only local operation and required for media features. The container supplies pinned, checksum-verified copies automatically.

## 2. Configure the environment

```bash
cp .env.example .env
```

At minimum, configure one AI provider and the WhatsApp owner:

```env
AI_API_BASE_URL=https://your-provider.example/v1
AI_API_KEY=your-provider-key
AI_MODEL_NAME=your-model
BOT_OWNER_JID=1234567890@s.whatsapp.net
```

For multiple providers, set `AI_PROVIDERS` and the corresponding `AI_<NAME>_BASE_URL`, `AI_<NAME>_API_KEY`, and `AI_<NAME>_MODEL` values. See [.env.example](../.env.example) for all routing, tool, media, and service settings.

Secrets should be generated independently:

```bash
openssl rand -base64 32
```

Keep `.env` outside source control and out of Docker build context.

## 3. Select messaging providers

### WhatsApp

Start the bot and scan the QR code with `BOT_OWNER_JID`. The Baileys authentication state is stored under the writable data directory. Back up that directory before moving hosts.

### Discord

Set a bot token before startup:

```env
DISCORD_BOT_TOKEN=your-discord-bot-token
```

The token is never passed to AI providers or webhooks.

## 4. Optional integrations

- Ollama: set `AI_OLLAMA_BASE_URL=http://127.0.0.1:11434/v1`, model, and tier.
- SearXNG: set `SEARXNG_URL`; keep the service on a trusted local/private network.
- Transcription: set `TRANSCRIBE_ENDPOINT` and `TRANSCRIBE_API_KEY` when required by the endpoint.
- Seerr: set `SEERR_API_URL`, `SEERR_API_KEY`, and a separate 24+ byte `SEERR_WEBHOOK_SECRET`.
- Jellyfin: set `JELLYFIN_API_URL`, API/user identifiers, and a separate 24+ byte `JELLYFIN_WEBHOOK_SECRET`.

A media webhook route with no configured secret returns `503`; it never accepts unauthenticated notifications.

## 5. Enable webhooks

```env
WEBHOOK_ENABLED=true
WEBHOOK_HOST=127.0.0.1
WEBHOOK_PORT=3500
WEBHOOK_SECRET=your-generated-secret
METRICS_AUTH_TOKEN=your-generated-metrics-secret
```

Use `X-Webhook-Secret` for generic and media requests. GitHub requests use `X-Hub-Signature-256`. Body/query secret compatibility is disabled unless separately enabled with future expiry values. See [api.md](api.md).

The native listener is not a TLS server. Put a trusted reverse proxy in front of it and expose only webhook routes.

## 6. Run

```bash
bun run start
```

For watch mode:

```bash
bun run dev
```

Before release, run:

```bash
bun run check
bun run test:webhooks
```

## Docker deployment

Create the external network, configure `.env`, and start Compose:

```bash
docker network create proxy
cp .env.example .env
docker compose build --pull
docker compose up -d
```

Compose uses a non-root image, read-only root filesystem, writable named volume at `/app/data`, and a host port bound only to `127.0.0.1`. See [deployment.md](deployment.md) for the reverse proxy and backup examples.

## Database lifecycle

ElastraX uses forward-only Drizzle migrations and SQLite WAL mode.

```bash
bun run db:check
bun run db:generate
bun run db:migrate
bun run db:backup
bun run db:restore
```

Only run `db:generate` when intentionally changing the schema, then commit `drizzle/` and `src/db/schema.ts` together. CI regenerates and fails on any uncommitted drift. Back up before applying or restoring migrations.

## Health and metrics

- `/live` and `/health`: minimal process liveness.
- `/ready`: compatibility readiness for an orchestrator.
- `/metrics`: protected Prometheus output; hidden if `METRICS_AUTH_TOKEN` is unset.

Do not expose any of these endpoints publicly. Keep liveness checks on a private container/health network and access metrics through a separately authenticated monitoring path.

## Troubleshooting

### Startup environment error

Read the first validation failure. Numeric bounds require decimal integers; booleans must be exactly `true` or `false`; compatibility deadlines require absolute RFC3339 timestamps. Secrets must contain at least 24 bytes without surrounding whitespace.

### Webhook returns `401`

Send `X-Webhook-Secret` with the exact configured value. Do not use body/query fields unless their bounded migration windows are enabled. GitHub uses a signature rather than the shared-secret header.

### Webhook returns `503`

A required secret is missing, webhook intake is disabled, or a durable enqueuer rejected the job. Media routes always fail closed without their own secret.

### Webhook returns `429`

The per-source/per-connection token bucket is exhausted. Honor `Retry-After`; do not disable limits for a public endpoint.

### Container cannot write data

Keep the `/app/data` named volume attached. A host bind mount must be writable by the image's non-root `bun` UID/GID; pre-create and `chown` such a mount before startup.

### Health check fails

Inspect container logs and verify `WEBHOOK_PORT`, the internal bind address, and private-network access. Never add a `0.0.0.0` host-port mapping to work around a proxy issue.
