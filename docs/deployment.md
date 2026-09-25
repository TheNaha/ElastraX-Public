# Deployment

## Supported runtime

Use Bun `1.3.14` everywhere. The version is pinned in `package.json`, CI, and the digest-pinned Docker base image. `bun.lock` is the only supported JavaScript dependency lock; do not generate or deploy from `package-lock.json`.

```bash
bun install --frozen-lockfile
bun run check
```

The container also pins and verifies yt-dlp `2026.08.19` plus an FFmpeg `8.1.2` build with SHA-256 checksums. Update those versions together with the Bun version, then rebuild and run CI.

## Required configuration

```bash
cp .env.example .env
openssl rand -base64 32
```

Set the AI provider, `BOT_OWNER_JID`, and `WEBHOOK_SECRET` when webhook intake is enabled. Values are parsed strictly: malformed booleans, non-integer bounds, weak secrets, non-RFC3339 compatibility deadlines, and unsafe hosts stop startup.

Generate separate secrets for `METRICS_AUTH_TOKEN`, `SEERR_WEBHOOK_SECRET`, and `JELLYFIN_WEBHOOK_SECRET`. Do not reuse the generic webhook secret.

## Docker Compose

Create the external proxy network once:

```bash
docker network create proxy
```

Then build and start:

```bash
docker compose build --pull
docker compose up -d
```

Compose behavior is intentionally private:

- Bun binds `0.0.0.0` only inside the container namespace and only with `WEBHOOK_CONTAINER_MODE=true`.
- The host publishes `${WEBHOOK_PORT:-3500}` on `127.0.0.1`, never on all host interfaces.
- The external `proxy` network is the only other network attached to the bot.
- The root filesystem is read-only; `/tmp` is a bounded tmpfs.
- Linux capabilities are dropped, privilege escalation is disabled, and the process runs as the image's non-root `bun` user.
- `elastrax-data` is a named volume mounted at `/app/data`. The database, media cache, and snapshots must remain on this writable volume.

Inspect the local-only listener:

```bash
curl --fail http://127.0.0.1:${WEBHOOK_PORT:-3500}/live
```

`/health` is a compatibility alias. `/ready` is intended for orchestration. Neither endpoint exposes metrics. Prometheus metrics remain unavailable unless `METRICS_AUTH_TOKEN` is configured and presented as a Bearer token.

## Reverse proxy example

Expose only webhook routes. Do not proxy `/metrics`, `/health`, or `/live` to the public Internet. This Caddy service must be attached to the external `proxy` network:

```caddyfile
bot.example.com {
    encode zstd gzip

    @webhooks path /webhook /webhook/*
    handle @webhooks {
        reverse_proxy bot:3500
    }

    respond 404
}
```

For a reverse proxy running directly on the Docker host, use `reverse_proxy 127.0.0.1:3500` instead. Preserve the original request body because GitHub HMAC verification runs over the exact bytes received. Apply a proxy body limit at least as restrictive as `WEBHOOK_MAX_BODY_BYTES`, and avoid logging query strings while compatibility authentication is enabled.

## Migrations

Migrations run forward-only at application startup. CI runs `bun run db:generate` and fails if it changes `drizzle.config.ts`, `drizzle/`, or `src/db/schema.ts`; this makes schema/migration drift fatal rather than silently accepting an uncommitted migration.

Back up the named volume before upgrading. Litestream remains optional:

```bash
cp litestream.yml.example litestream.yml
docker compose --profile backup up -d
```

The backup sidecar receives only the two Litestream credential variables rather than the bot's full `.env` file.

## Release checks

A release is publishable only after CI passes all gates:

1. frozen dependency installation;
2. Gitleaks scan with no blanket fixture allowlist;
3. fatal migration-generation drift check and fresh migration smoke;
4. lint, typecheck, and tests;
5. Compose validation;
6. pinned Docker build and non-root/read-only webhook smoke.

The publish workflow builds `linux/amd64` and `linux/arm64`, pushes only from `main` or version tags, and attaches provenance and an SBOM. It does not deploy.
