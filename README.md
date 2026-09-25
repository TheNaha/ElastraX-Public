# ElastraX

ElastraX is a Bun/TypeScript AI agent for WhatsApp and Discord. It supports OpenAI-compatible and Google AI providers, a persisted tool/flow system, scheduled jobs, media handling, inbound webhooks, and SQLite.

## Runtime

Bun `1.3.14` is the single supported runtime for local development, CI, and containers. The version and package-manager contract are pinned in `package.json`; `bun.lock` is the dependency lock.

Requirements for native development:

- Bun 1.3.14
- FFmpeg and yt-dlp available on `PATH` only when media conversion/downloading is used
- an AI provider and credentials

## Quick start

```bash
bun install --frozen-lockfile
cp .env.example .env
```

Set at minimum:

```env
AI_API_BASE_URL=https://your-provider.example/v1
AI_API_KEY=your-provider-key
AI_MODEL_NAME=your-model
BOT_OWNER_JID=1234567890@s.whatsapp.net
NODE_ENV=development
```

Start the agent:

```bash
bun run start
```

For WhatsApp, scan the QR code with the owner account. For Discord, set `DISCORD_BOT_TOKEN` before startup. Both providers can run in the same process.

## Release identity

The current release is **ElastraX v8.0.1**.

- Package name: `elastrax`
- Package version: `8.0.1`
- Git/Docker release tag: `v8.0.1`
- Runtime contract: Bun `1.3.14`
- Liveness/readiness responses expose the release version and tag.

Create the release tag only after the verification commit is on `main`:

```bash
git tag -a v8.0.1 -m "ElastraX v8.0.1"
git push origin v8.0.1
gh workflow run docker-publish.yml --ref main \
  -f release_tag=v8.0.1 \
  -f publish_latest=true
```

Publish and deploy by immutable image digest rather than a mutable `latest` tag.

## Operational verification

- [CI diagnostics](docs/ci-diagnostics.md) — distinguish code failures from account-side Actions scheduling failures.
- [Provider staging matrix](docs/provider-staging-matrix.md) — credential-free harness plus the manual real-provider acceptance matrix.
- [Canary runbook](docs/canary-runbook.md) — backup, preflight, digest-pinned deploy, verification, and rollback.
- [Open PR triage](docs/open-pr-triage.md) — read-only inventory of duplicate, superseded, obsolete, and security-sensitive proposals.
- [Room identity migration](docs/room-identity-migration.md) — canonical room keys, additive backfill, dual reads/writes, and rollback rules.

The same checks are available as scripts:

```sh
bun run ci:diagnose
bun run provider:staging
bun run db:room-keys
```

## Webhooks

Inbound webhooks are disabled unless explicitly enabled:

```env
WEBHOOK_ENABLED=true
WEBHOOK_SECRET=generate-with-openssl-rand-base64-32
WEBHOOK_PORT=3500
WEBHOOK_HOST=127.0.0.1
```

Use `X-Webhook-Secret`; do not put secrets in URLs:

```bash
curl --fail-with-body http://127.0.0.1:3500/webhook \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -H 'X-Webhook-Id: alert-123' \
  --data '{
    "room_id": "120363xxxxxx@g.us",
    "title": "Production alert",
    "message": "HTTP 5xx ratio exceeded 5%",
    "priority": "critical",
    "source": "prometheus",
    "tags": ["production", "api"]
  }'
```

JSON-body and query-string secrets are disabled by default. They can be enabled only inside separate, explicit RFC3339 expiry windows. Media routes use independent secrets and fail closed. GitHub routes use `X-Hub-Signature-256`; `X-GitHub-Delivery` provides replay detection.

Exact routes, limits, replay behavior, and the optional durable-outbox `202` contract are documented in [docs/api.md](docs/api.md).

## Operations

- `GET /health` and `GET /live` return minimal liveness only.
- `GET /ready` is a compatibility readiness hook.
- `GET /metrics` is hidden unless `METRICS_AUTH_TOKEN` is configured and protected with a Bearer token.
- Native startup binds loopback by default. Never publish the webhook port directly to the Internet.
- Unknown paths return `404`; wrong methods and non-JSON webhook posts fail explicitly.

## Docker

The image uses a digest-pinned Bun base, checksum-verified yt-dlp/FFmpeg downloads, a non-root user, a read-only root filesystem, a writable named data volume, dropped capabilities, and no public host port.

```bash
docker network create proxy
cp .env.example .env
docker compose build --pull
docker compose up -d
```

Compose publishes only `127.0.0.1:${WEBHOOK_PORT:-3500}`. Terminate TLS at a trusted reverse proxy and expose only `/webhook` and `/webhook/*`; do not expose liveness or metrics publicly. See [docs/deployment.md](docs/deployment.md) for the Caddy example and operational gates.

## Development

```bash
bun run check
bun run test:webhooks
bun run test:coverage
```

`bun run check` runs lint, typecheck, and the full test suite. Database commands are:

```bash
bun run db:generate
bun run db:check
bun run db:migrate
bun run db:backup
bun run db:restore
```

`db:generate` must not create an uncommitted migration during CI; schema and `drizzle/` drift is a fatal release failure. Back up SQLite before migration or restore.

## CI and releases

CI performs frozen installation, secret scanning, fatal migration-drift detection, migration smoke, lint, typecheck, tests, Compose validation, a pinned Docker build, and a non-root/read-only webhook smoke. The image publish workflow supports `linux/amd64` and `linux/arm64` and attaches an SBOM and provenance. It publishes artifacts only and does not deploy.

## Configuration

[.env.example](.env.example) is the complete annotated configuration reference. Important groups include:

- single-provider and multi-provider AI routing;
- WhatsApp and Discord credentials;
- tools, flows, scheduler, memory, and media limits;
- Ollama, SearXNG, and transcription;
- Seerr and Jellyfin integrations;
- bounded webhook, replay, rate, and metrics settings.

## Architecture

- `src/runtime` starts and stops providers, the message queue, jobs, health monitoring, webhooks, and cleanup.
- `src/agent` resolves providers and executes permissioned AI/tool loops.
- `src/flows` contains schema-validated automation flows.
- `src/db` owns Drizzle, forward migrations, repositories, and backup support.
- `src/webhooks` contains exact route handling, auth, adapters, limits, and delivery contracts.
- `src/providers` contains WhatsApp, Discord, media, and outbound integrations.
- `src/utils` contains shared infrastructure and services.
- `src/plugins` contains runtime plugin tooling; user flow files are stored in the data directory.

See [docs/architecture.md](docs/architecture.md), [docs/flows.md](docs/flows.md), [docs/tools.md](docs/tools.md), and [docs/setup.md](docs/setup.md) for subsystem details.

## Security notes

- Do not commit `.env`, databases, backups, or Litestream credentials.
- Generate at least 24 random bytes for every webhook/metrics secret.
- Keep the listener private and use a reverse proxy for TLS and access controls.
- Do not grant `allow_all` tool permissions; use owner/admin/user/allowed-user scopes.
- Keep generated backups out of the Git working tree.
