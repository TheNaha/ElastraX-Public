# Admin Dashboard

The admin dashboard (`/admin`) is a read-mostly operator dashboard served on the same Bun HTTP listener as the webhook intake. It is disabled entirely (every path answers `404`) unless `METRICS_AUTH_TOKEN` is set to at least 24 bytes. It reuses the same token that gates `/metrics`; there are no user accounts to manage.

## Enabling the dashboard

```env
METRICS_AUTH_TOKEN=<24+ random bytes>
```

Generate the token:

```bash
openssl rand -base64 32
```

A shorter token disables both `/metrics` and `/admin` (they fail closed) and logs a warning; it does not stop the bot from starting. A malformed value (leading/trailing whitespace) is a hard startup error.

## Authentication flow

1. **Sign in**: `POST /admin/api/login` with `{"token": "<METRICS_AUTH_TOKEN>"}` and `Content-Type: application/json`.
2. The response carries an `HttpOnly; SameSite=Strict` session cookie and a CSRF token.
3. Send the CSRF token in the `x-admin-csrf` header on every mutating request.
4. The cookie carries the `Secure` attribute except for a loopback request over plain HTTP, because a browser silently refuses to store a `Secure` cookie without TLS. Remote deployments keep the attribute; `ADMIN_COOKIE_INSECURE=true` relaxes it for a LAN address over plain HTTP.
5. `POST /admin/api/logout` ends the session.

## Route table

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/admin` | Dashboard shell; redirects to `/admin/login` without a session |
| `GET` | `/admin/app.js` | Dashboard JavaScript bundle (static asset) |
| `GET` | `/admin/style.css` | Dashboard stylesheet (static asset) |
| `GET` | `/admin/login` | Dashboard login page |
| `POST` | `/admin/api/login` | Exchange `METRICS_AUTH_TOKEN` for a session cookie |
| `POST` | `/admin/api/logout` | End the session |
| `GET` | `/admin/api/*` | Dashboard views: overview, tools, rooms, delivery, reminders, roomkeys, feedback, config, session |
| `POST` | `/admin/api/action/*` | Dashboard actions: registry reload, outbox retry, delete knowledge, retention report |

All other paths return `404`. The admin handler shares the webhook port; reverse proxies must forward `/admin` as well as `/webhook`. The Caddy example in `docs/deployment.md` proxies both.

## Dashboard views

The `/admin/api/*` views are read-only operator surfaces:

- **Overview**: process version, release tag, provider statuses, readiness.
- **Tools**: registered tool list, permissions, mutability, plugin load reports.
- **Rooms**: room keys, platform, language, config.
- **Delivery**: inbox/outbox row states, retry counts, dead-lettered rows.
- **Reminders**: upcoming and past-due reminders, recurrence, send state.
- **Roomkeys**: canonical room-key coverage and conflicts (`db:room-keys` report).
- **Feedback**: reaction totals and retracts (Prometheus counters `elastrax_feedback_total`, `elastrax_feedback_retracted_total`).
- **Config**: resolved environment configuration (secrets redacted).

## Dashboard actions

`POST /admin/api/action/*` mutating actions:

- `reload-registry` — reloads the tool registry (built-in tools plus a fresh evaluation of every plugin in `src/plugins/`). In-flight tool calls are unaffected.
- `retry-outbox` — returns a `failed` or `dead_letter` outbox row to `pending` with its attempt counter cleared; the normal claim path delivers it on its next tick.
- `delete-knowledge` — removes room knowledge base entries.
- `retention-report` — runs retention in dry-run mode and returns counts.

Every mutating request requires the CSRF token in `x-admin-csrf`.

## Request bounds

The dashboard shares a listener that sets no `maxRequestBodySize`, so its own handlers bound every body before parsing:

- `POST /admin/api/login` reads at most **4 KiB**;
- `POST /admin/api/action/*` reads at most **64 KiB**;
- oversized bodies fail with `413`, a stalled read with `408`, and a non-object or malformed JSON body with `400`.

Login attempts are throttled per client IP (5 attempts per 60 s, bounded table), and at most 32 sessions are kept; the oldest is evicted on login. A rejected mutation also needs the request to be same-origin, a valid session, and the CSRF header.

## Deployment notes

- The dashboard lives on the same port as webhook intake. Native startup binds `127.0.0.1` by default; never publish the webhook port directly to the internet. Terminate TLS at a trusted reverse proxy.
- The session cookie is the only thing standing between the dashboard and the public internet. Restrict `/admin` to the operator's network in the reverse proxy.
- `/metrics` (Prometheus output, `text/plain; version=0.0.4`) is protected by the same token and presented as `Authorization: Bearer <token>` or `X-Metrics-Token`. Query-string metrics authentication is not supported.

## Verification

```
bun test --no-env-file test/admin.test.ts
```

Start the bot with `METRICS_AUTH_TOKEN` set, then `curl -fsS http://127.0.0.1:3500/admin` should return the login page; without the token it returns `404`.