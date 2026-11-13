# Database

ElastraX uses SQLite via Bun's built-in `bun:sqlite` driver with Drizzle ORM (`drizzle-orm` 0.45.4). `better-sqlite3` is never installed (`bunfig.toml` sets `peer = false`). There is no build step; `src/index.ts` runs directly under Bun.

## Connection and schema

`src/db/index.ts` creates the default database handle lazily on first use:

- Path: `ELASTRAX_DB_PATH` (default `./data/bot.db`); `':memory:'` disables persistence.
- Busy timeout: `ELASTRAX_DB_BUSY_TIMEOUT_MS` (default `5000`, range 0–120,000).
- Journal mode: WAL (except `:memory:`).
- Synchronous: `ELASTRAX_DB_SYNCHRONOUS` (`OFF`, `NORMAL`, `FULL`; default `FULL`).
- `foreign_keys = ON`, `wal_autocheckpoint = 1000`.

The default handle is a singleton exposed as `db` (Drizzle client) and `sqlite` (raw `bun:sqlite` handle). `isSchemaReady()` returns true once migrations have run and the schema fingerprint has been recorded.

## Startup migration

`ensureDatabaseSchema()` (`src/db/index.ts`) is called during bootstrap (`src/index.ts`):

1. Ensures the lease table.
2. Inspects the migration state from `drizzle/migrations/`.
3. Acquires the migration lease (`elastrax:migration`); if another process holds it, startup fails.
4. Verifies the stored schema fingerprint.
5. Applies pending forward migrations with `drizzle migrate`.
6. Validates the schema contract (`validateSchemaContract` in `src/db/migrations.ts`).
7. Runs `afterMigrationCallbacks` to invalidate schema-aware caches.
8. Records a schema fingerprint keyed by the newest journal `when` value and applied migration count.
9. Acquires the runtime lease (`elastrax:runtime`) with a heartbeat (renewed every `ttlMs / 3`, default 300 s TTL). If the runtime lease is held by another process, startup fails — this is the single-instance guard: two bots must never open the same data volume.

## Migrations

- Edit `src/db/schema.ts`, then run `bun run db:generate` (drizzle-kit).
- `db:push` is disabled (`package.json` script prints an error and exits 1).
- `db:migrate` runs `scripts/dbBackup.ts migrate`: backs up first, then applies forward migrations.
- After `drizzle-kit generate`, rename the new file and its journal tag to the next `00NN_` number, set `when` to the next integer, and ensure a matching `meta/00NN_snapshot.json` exists.
- `drizzle/migrations/meta/_journal.json` uses small sequential integers for `when` (1..N), not timestamps. `src/db/migrations.ts` validates these values and hardcodes some (`ROOM_KEY_MIGRATION_WHEN` and a checksum allowance keyed by journal position).
- Applied migrations are hash-checked; never edit a shipped `.sql` file.
- CI runs `bun run db:generate` and fails if it changes `drizzle.config.ts`, `drizzle/`, or `src/db/schema.ts` — schema/migration drift is fatal.

Snapshots are missing for some old migrations, and drizzle-kit diffs against the newest snapshot.

## Retention

`src/db/retention.ts` deletes terminal inbox/outbox rows, terminal deliveries, sent reminders, flow sessions, and old messages according to the `RETENTION_*` knobs. It defaults to dry-run. `scripts/runRetention.ts` exposes `--apply`. Retention runs on startup and every 24 h via AppRuntime, and overlaps with the hourly outbox prune; deletes are idempotent.

| Knob | Default | Purpose |
|---|---|---|
| `RETENTION_DRY_RUN` | `true` | Dry-run unless `false`. |
| `RETENTION_MESSAGES_DAYS` | `180` | Delete messages older than this. |
| `RETENTION_MESSAGE_GRACE_DAYS` | `30` | Grace period added to message retention. |
| `RETENTION_TERMINAL_DELIVERY_DAYS` | `90` | Terminal delivery record retention. |
| `RETENTION_SENT_REMINDER_DAYS` | `90` | Sent reminder retention. |
| `RETENTION_FLOW_SESSION_DAYS` | `30` | Flow session retention. |
| `RETENTION_BATCH_SIZE` | `500` | Deletion batch size. |

## Backups and restore

- `bun run db:backup` writes consistent `VACUUM INTO` snapshots to `BACKUP_DIR` (default `./data/backups`), keeps `BACKUP_KEEP` (default 7).
- `bun run db:restore` restores from a backup, validating integrity, foreign keys, schema version, and fingerprint before writing.
- `bun run db:preflight` validates a restored copy before migration (read-only).
- Never point tests at `data/bot.db`; the test harness uses temp databases and fails the run if anything under repo `data/` changes.

## Database commands

| Command | Script | Purpose |
|---|---|---|
| `bun run db:generate` | drizzle-kit | Generate a migration from `src/db/schema.ts`. Must leave no uncommitted drift. |
| `bun run db:check` | drizzle-kit | Validate migration journal/snapshots. |
| `bun run db:studio` | drizzle-kit | Open Drizzle Studio against the configured database (local dev only). |
| `bun run db:migrate` | `scripts/dbBackup.ts migrate` | Apply forward migrations after a backup. |
| `bun run db:preflight` | `scripts/dbBackup.ts preflight` | Validate a restored copy before migration. |
| `bun run db:backup` | `scripts/dbBackup.ts backup` | Write a consistent `VACUUM INTO` snapshot. |
| `bun run db:restore` | `scripts/dbBackup.ts restore` | Restore from a backup (validates integrity/foreign keys/schema version). |
| `bun run db:room-keys` | `scripts/dbRoomKeys.ts` | Read-only report of canonical room-key coverage and conflicts. |
| `bun run db:room-keys:record` | `scripts/dbRoomKeys.ts --record-conflicts` | Record conflict audit rows. |
| `bun run db:embed` | `scripts/backfillEmbeddings.ts` | Re-embed stored memories after changing the embedding model. |
| `bun run db:retention` | `scripts/runRetention.ts` | Dry-run retention (default). Add `-- --apply` to delete. |

## Verification

```
bun run db:check
bun run db:generate        # must report no uncommitted drift
bun test --no-env-file test/migration.test.ts
bun test --no-env-file test/zz.db.index.test.ts
bun test --no-env-file test/dbBackup.test.ts
bun test --no-env-file test/dbRoomKeysScript.test.ts
```