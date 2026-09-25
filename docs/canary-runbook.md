# Canary Runbook

Single-instance, digest-pinned, reversible rollout of one ElastraX image. One bot process is a deliberate constraint: SQLite plus a runtime lease mean a second instance must never run against the same data volume. Every step below is written so that the previous release can be restored with one variable change and one `up -d`.

Release under test: ElastraX `v8.0.1`. Runtime: Bun `1.3.14`. `bun.lock` is the only supported lockfile.

## 0. Roles and prerequisites

- One operator, one verifier, one written record. The record holds: commit SHA, image digest, backup path and manifest, every probe result, and the go/no-go decision.
- Verified locally before touching the host: `bun install --frozen-lockfile && bun run check`.
- Known external blocker: GitHub Actions is currently not executing any step, so CI cannot be the gate. Local `bun run check` plus a successful image build is the gate. See [ci-diagnostics](./ci-diagnostics.md).

## 1. Backup (mandatory, before any change)

Order matters: backup first, verify the backup, and only then stop the running instance. `dbBackup backup` uses SQLite's online backup, so a snapshot is consistent while the bot is serving traffic.

The production image ships `src/`, `drizzle/`, and the manifests — **not** `scripts/`. Run the maintenance commands from a one-off container that mounts the volume and a read-only copy of `scripts/` from a verified checkout:

```bash
export IMAGE="ghcr.io/thenaha/elastrax@sha256:<digest>"
export VOLUME="$(docker volume ls -q --filter name=elastrax-data | head -1)"

docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --user "$(id -u):$(id -g)" \
  --volume "$VOLUME":/app/data \
  --volume "$PWD/scripts":/app/scripts:ro \
  --workdir /app \
  --entrypoint bun "$IMAGE" \
  run scripts/dbBackup.ts backup
```

Expected evidence:

- stdout contains `Snapshot:`, `Manifest:`, and `Bytes:` lines;
- exit code `0`; a non-zero exit is a hard stop;
- the manifest in `/app/data/backups/` records `integrityCheck: "ok"`, `foreignKeyViolations: 0`, a schema fingerprint, the migration count, and the latest migration tag;
- the snapshot's recorded `sha256` matches the file on disk.

Then prove the snapshot is restorable into a scratch file, never over the live database:

```bash
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --user "$(id -u):$(id -g)" \
  --env DB_BACKUP_PATH="/app/data/backups/<snapshot>.db" \
  --env DB_RESTORE_PATH=/app/data/restore-check/bot.db \
  --volume "$VOLUME":/app/data \
  --volume "$PWD/scripts":/app/scripts:ro \
  --workdir /app \
  --entrypoint bun "$IMAGE" \
  run scripts/dbBackup.ts restore
```

A successful restore prints `Validated new database:`. Delete the scratch file afterwards. A backup that has not been restored is not a backup.

The same one-off pattern is used for `preflight` and `retention` below (`run scripts/dbBackup.ts preflight`, `run scripts/runRetention.ts`). If instead you operate from a host checkout that can already see the database file, the equivalent `bun run db:backup`, `db:preflight`, and `db:retention` commands apply with `ELASTRAX_DB_PATH` and `BACKUP_DIR` set.

Optional continuous backup: `docker compose --profile backup up -d` (Litestream, digest-pinned) — see [deployment](./deployment.md). Litestream receives only its two credential variables, never the bot's `.env`.

## 2. Preflight

Preflight opens the database read-only and must pass before the old instance is stopped. Use the one-off container from section 1 so the same volume and the same schema are inspected.

```bash
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --user "$(id -u):$(id -g)" \
  --volume "$VOLUME":/app/data --volume "$PWD/scripts":/app/scripts:ro \
  --workdir /app --entrypoint bun "$IMAGE" run scripts/dbBackup.ts preflight

docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --user "$(id -u):$(id -g)" \
  --volume "$VOLUME":/app/data --volume "$PWD/scripts":/app/scripts:ro \
  --workdir /app --entrypoint bun "$IMAGE" run scripts/runRetention.ts
```

Also verify the host-side configuration, which needs no database access:

```bash
docker compose config --quiet
docker network inspect proxy >/dev/null
```

Checklist:

1. `Pending: 0`. Any pending migration means the canary image will migrate on first boot — confirm that is intended and that section 1's backup covers it.
2. The fingerprint from preflight equals the fingerprint in the backup manifest. A mismatch means the database moved under you; stop and re-back up.
3. The retention dry run reports plausible counts, not sudden deletions. Retention deletes messages older than 180 days with a 30-day grace period by default; the numbers must be explainable.
4. `docker compose config --quiet` is clean, so the canary env file parses.
5. Disk headroom on the data volume: snapshot + restored scratch copy + WAL headroom.

## 3. Image digest (immutable)

Deploy by digest, never by a mutable tag.

```bash
docker pull ghcr.io/thenaha/elastrax:v8.0.1
docker image inspect ghcr.io/thenaha/elastrax:v8.0.1 \
  --format '{{index .RepoDigests 0}}'          # ghcr.io/thenaha/elastrax@sha256:...
docker run --rm --entrypoint bun ghcr.io/thenaha/elastrax@sha256:<digest> --version
```

The last command must print Bun `1.3.14`; the image is digest-pinned to a Bun base image, so a different runtime version means the wrong artifact. The application version is verified from the running instance in section 5 (`/health` and `/ready` both report `version` and `releaseTag`).

Record the digest in the run record and pin it for the canary:

```bash
export ELASTRAX_IMAGE="ghcr.io/thenaha/elastrax@sha256:<digest>"
docker compose config | grep -F "$ELASTRAX_IMAGE"     # confirm the pin is in effect
```

Rules:

- The digest, not the tag, goes in the record. `v8.0.1` can be re-pushed; a digest cannot.
- Rollback uses the previously recorded digest. Keep both digests in the record before starting.
- Do not rebuild the image on the canary host. The build belongs to CI or a workstation, with pinned base image, pinned yt-dlp/FFmpeg checksums, and an SBOM.

## 4. One-instance deploy

1. Announce the window and stop the bot. `docker compose stop bot` sends SIGTERM and waits the configured 30 s grace period so in-flight replies and the media queue drain.
2. Confirm it is fully stopped before starting anything: `docker compose ps -a bot` shows no running container, and no second process holds the data volume.
3. Start the new image:

```bash
ELASTRAX_IMAGE="ghcr.io/thenaha/elastrax@sha256:<digest>" docker compose up -d --no-build bot
docker compose ps
docker compose logs --tail 200 bot
```

Startup must show, in order: schema ensured (applied count, fingerprint), provider connect (`Connected successfully.` / `Logged in as …`), webhook server listening, then `Bot is running` with the ready provider list.

Single-instance invariants to verify during the canary:

- exactly one container for the `bot` service, and only one process inside it;
- the runtime lease is held by this process; a second instance refuses to start rather than opening the same database;
- the data volume is still the only writable path, and `/` remains read-only inside the container.

## 5. Health and readiness

Probe in this order. `/live` is liveness only and must not be used as a readiness gate.

| Probe | Command | Healthy | Meaning when unhealthy |
|-------|---------|---------|------------------------|
| Liveness | `curl -fsS http://127.0.0.1:${WEBHOOK_PORT:-3500}/live` | 200 | The process is wedged; restart is warranted |
| Compatibility alias | `curl -fsS .../health` | 200, `version: 8.0.1`, `releaseTag: v8.0.1` | Wrong binary or version skew |
| Readiness | `curl -sS -o /dev/null -w '%{http_code}' .../ready` | 200 `status: ready` | 503 `status: not_ready` — inspect the cause, do not restart blindly |
| Metrics (private) | `curl -fsS -H "Authorization: Bearer $METRICS_AUTH_TOKEN" .../metrics` | 200 | 404/401 means the token is unset or wrong; metrics stay private either way |
| Webhook auth | `curl -sS -o /dev/null -w '%{http_code}' -X POST .../webhook -d '{}'` | 401 | 2xx would mean unauthenticated intake is open — stop the canary |
| Duplicate protection | Replay the same authenticated body **with the same delivery id** | First: 202 `status: queued`. Replay: 202 `status: duplicate`, `duplicate: true`, no second delivery | Two `status: queued` responses for one delivery id mean replay protection regressed |

Readiness is the composed check: the runtime has started, the database schema is ready, the message queue is not stopped, and **at least one** provider is operational. A 503 therefore has exactly three possible causes: schema not ready, queue stopped, or no operational provider. Get the reason from the container log rather than restarting.

The container `HEALTHCHECK` polls `/ready` every 30 s with a 45 s start period and 3 retries. Allow the start period to elapse before judging readiness; WhatsApp QR pairing and Discord login can legitimately take longer on a cold start, and Discord reaching `not_configured` never becomes ready on its own.

Canary observation window: at least 30 minutes, or one full digest/report cycle, whichever is longer, covering at least one real inbound message, one outbound reply, and one media message per configured provider.

## 6. Rollback

Rollback is: stop, repin the previous digest, start, probe. No data rollback is required for a pure image rollback, because the previous image is the one that wrote the current schema.

```bash
docker compose stop bot
ELASTRAX_IMAGE="ghcr.io/thenaha/elastrax@sha256:<previous-digest>" docker compose up -d --no-build bot
curl -fsS http://127.0.0.1:${WEBHOOK_PORT:-3500}/ready
```

Data rollback is a separate, destructive decision:

1. Stop the bot.
2. Run the one-off restore container from section 1 (not a host command), with `DB_RESTORE_PATH` pointing at a path that does not exist yet. The restore validates integrity, foreign keys, the schema contract, and the expected schema version before writing the destination.
3. Swap the file into place inside the volume, preserving ownership (`bun:bun`) and mode, for example with a one-off container that copies `/app/data/restore-check/bot.db` over the stopped instance's database and removes the `-wal`/`-shm` sidecars.
4. Start, then re-run the section 5 probes, including retention compatibility below.

Never restore over the live database file. If the canary wrote a schema the old image cannot read, restoring is the only safe path; if it did not, keep the newer data and roll back only the image.

## 7. Retention compatibility across the canary

Retention runs inside the process and deletes rows. It must be compatible with both the image being rolled back to and the image being rolled forward to.

1. Dry run first, always: the `run scripts/runRetention.ts` invocation from section 2 prints the counts without deleting. Apply only after a verified backup and a stopped single instance, by running the same one-off container **without** `--read-only` on the volume and with the apply flag:

```bash
docker run --rm --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --user "$(id -u):$(id -g)" \
  --volume "$VOLUME":/app/data --volume "$PWD/scripts":/app/scripts:ro \
  --workdir /app --entrypoint bun "$IMAGE" \
  run scripts/runRetention.ts --apply
```

2. The five policy knobs (`RETENTION_MESSAGES_DAYS` 180, `RETENTION_MESSAGE_GRACE_DAYS` 30, `RETENTION_SENT_REMINDER_DAYS` 90, `RETENTION_TERMINAL_DELIVERY_DAYS` 90, `RETENTION_FLOW_SESSION_DAYS` 30) must be identical for the old and new image. Differing values mean the rollback image would apply different deletion windows to the same rows.
3. Retention deletes messages, reminders, inbox/outbox rows, terminal deliveries, and flow sessions. A rollback to an image that expects columns retention removed must be rejected in preflight: the restore/contract validation covers this, which is why preflight and a scratch restore are mandatory.
4. Compare dry-run output before and after the canary. A sudden change in any count between the two digests is a retention-compatibility failure: stop and investigate before proceeding.
5. `dryRun` defaults to true. Applying retention against a live bot without a verified backup and a stopped deployment is prohibited.

## 8. WhatsApp 515 reconnect versus readiness failure

These look similar in a dashboard and require opposite responses. Telling them apart is the single most common canary misdiagnosis.

| Signal | 515 reconnect (recoverable) | Readiness failure (investigate) |
|--------|---------------------------|----------------------------------|
| Log | `Connection closed` with status `515`, then `Scheduling reconnect` with `delayMs` | No close event; provider simply never reaches `running` |
| Provider status | `backoff`, then `running` after the delay | `error`, or stays `starting`, or `not_configured` |
| `/ready` | 503 **transiently**, then 200 with no intervention | 503 **persistently** — the cause is not self-healing |
| `/live` | 200 throughout | usually 200, which is exactly why `/live` must not gate the canary |
| Reconnect behaviour | Exponential backoff from 1 500 ms, capped at 300 000 ms; attempt counter resets on a successful open | No reconnect is scheduled at all |
| Session | Session stays paired; recovery needs no QR scan | QR needed, or credentials rejected |
| Response | **Wait.** Do not restart, do not re-pair, do not roll back | Investigate: auth state, `BOT_OWNER_JID`, network egress, or a code regression |

Rule of thumb: **515 is a reconnect, not an outage.** Status `515` means the session was restarted elsewhere and must be re-established; the provider is expected to recover on its own, and the expected evidence is a `backoff` → `running` transition in the log plus a `/ready` recovery to 200 without a restart.

A readiness failure that is *not* self-healing looks different: the provider never opens a connection (bad or missing auth state, blocked egress, or a real regression), or it reports status `error` and schedules no reconnect — for example after close code `401` (logged out), which is terminal by design and requires re-pairing rather than waiting.

Canary rule: allow the transient 503 window to elapse (two backoff intervals, at most 10 minutes). If `/ready` is still 503 after that, treat it as a readiness failure: capture the log, `/ready` body, `Provider event already completed` lines, and the image digest, then decide between rollback and investigation.

## 9. Go / no-go

Go requires all of:

- verified backup plus a successful scratch restore;
- preflight clean, `Pending: 0`, fingerprint matching the manifest;
- image deployed by digest, digest recorded;
- exactly one instance, correct startup order in the log;
- `/live` 200, `/ready` 200, `/health` reporting `version: 8.0.1` / `releaseTag: v8.0.1`, unauthenticated `/webhook` 401, `/metrics` private;
- at least one real inbound message, reply, and media message per configured provider;
- retention dry-run counts stable across the canary;
- no unexplained 503 in the observation window that outlived the reconnect window in section 8.

No-go on any missing item. Record the reason; do not proceed "provisionally".
