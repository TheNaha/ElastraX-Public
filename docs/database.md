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
4. Compares the stored schema fingerprint with the live schema. The fingerprint is a cache, so a stored migration count behind the journal means a crash happened between `migrate()` and the recording step: the fingerprint is re-recorded with a warning. A mismatch with an up-to-date count is a real schema change without a migration and aborts startup.
5. Applies pending forward migrations with `drizzle migrate`.
6. Validates the schema contract (`validateSchemaContract` in `src/db/migrations.ts`).
7. Runs `afterMigrationCallbacks` to invalidate schema-aware caches. The only registered callback is the room-key schema catalog (`src/db/rooms.ts`), which memoises `sqlite_master` / `pragma_table_xinfo` probes per database handle so room-key resolution does not query the catalog on every inbound message.
8. Records a schema fingerprint keyed by the newest journal `when` value and applied migration count.
9. Acquires the runtime lease (`elastrax:runtime`) with a heartbeat (renewed every `ttlMs / 3`, default 300 s TTL). If the runtime lease is held by another process, startup fails — this is the single-instance guard: two bots must never open the same data volume.

## Migrations

- Edit `src/db/schema.ts`, then run `bun run db:generate` (drizzle-kit).
- `db:push` is disabled (`package.json` script prints an error and exits 1).
- `db:migrate` runs `scripts/dbBackup.ts migrate`, which calls `ensureDatabaseSchema` (back it up yourself first with `db:backup`; the script does not do it).
- After `drizzle-kit generate`, rename the new file and its journal tag to the next `00NN_` number, set `when` to the next integer, and ensure a matching `meta/00NN_snapshot.json` exists.
- `drizzle/migrations/meta/_journal.json` uses small sequential integers for `when` (1..N), not timestamps. `src/db/migrations.ts` validates these values and hardcodes some (`ROOM_KEY_MIGRATION_WHEN` and a checksum allowance keyed by journal position). The ledger's own `created_at` is **not** compared with `when`: journals from earlier commits used `null` and epoch milliseconds, so equality would reject every database migrated back then. A row is identified by its position, whose checksum must still match the file.
- Applied migrations are hash-checked; never edit a shipped `.sql` file.
- CI runs `bun run db:generate` and fails if it changes `drizzle.config.ts`, `drizzle/`, or `src/db/schema.ts` — schema/migration drift is fatal.
- `REQUIRED_INDEXES` in `src/db/migrations.ts` is the index contract: startup validation fails when a required index is missing, and `test/migration.test.ts` asserts set equality against a freshly migrated database, so a new index must be added to the list.

Snapshots are missing for some old migrations, and drizzle-kit diffs against the newest snapshot.

## Retention

`src/db/retention.ts` deletes terminal and stale inbox/outbox rows, sent one-off reminders, flow sessions, and old messages according to the `RETENTION_*` knobs. Independently of those knobs, it clears `messages.raw_message`, `media_path`, and `mime_type` for rows older than 7 days. It defaults to dry-run. `scripts/runRetention.ts` exposes `--apply`. Retention runs on startup and every 24 h via AppRuntime (only when a durable messaging store is present), and overlaps with the hourly outbox prune; deletes are idempotent.

Timestamps are read through a mixed-unit normalisation (`CASE WHEN ts > 100000000000 THEN ts ELSE ts * 1000 END`), because rows written before the unit clean-up are still stored in seconds. A cutoff wrapped in that expression cannot be range-seeked, so each predicate also carries the plain `column < ?` comparison the normalised form implies in both units (seconds are always below a millisecond cutoff), and the cutoff is bound twice. Together with migration `0026_retention_indexes` (`messages(created_at)`, `reminders(created_at)`, both in `REQUIRED_INDEXES`) this turns a full scan into an index range seek for `messages`, `raw_message`, `reminders` and `flow_sessions`. `message_inbox`/`message_outbox` still evaluate their cutoff as a filter rather than a range seek, because `COALESCE(completed_at|sent_at, updated_at)` spans two columns; changing that would change which timestamp decides expiry.

| Knob | Default | Purpose |
|---|---|---|
| `RETENTION_DRY_RUN` | `true` | Dry-run unless `false`. |
| `RETENTION_MESSAGES_DAYS` | `180` | Delete messages older than this. |
| `RETENTION_MESSAGE_GRACE_DAYS` | `30` | Grace period added to message retention. |
| `RETENTION_TERMINAL_DELIVERY_DAYS` | `90` | Terminal **and stale** inbox/outbox row retention. |
| `RETENTION_SENT_REMINDER_DAYS` | `90` | Sent reminder retention. |
| `RETENTION_FLOW_SESSION_DAYS` | `30` | Flow session retention. |
| `RETENTION_BATCH_SIZE` | `500` | Deletion batch size. |

## Backups and restore

- `bun run db:backup` writes consistent `VACUUM INTO` snapshots to `BACKUP_DIR` (default `./data/backups`), keeps `BACKUP_KEEP` (default 7), and prunes older snapshots with their manifests. Pruning refuses a manifest whose `snapshot.file` is not a bare filename inside the backup directory, and sweeps `*.db` snapshots that have no manifest after a 1 h grace (a snapshot is published just before its manifest).
- `bun run db:restore` restores from a backup, validating integrity, foreign keys, the backup's own manifest, and that its schema is **not newer** than this build. A snapshot from an older release is the normal rollback case: the script then runs the pending migrations on the restored copy and validates the schema contract. A destination that still has a `-wal`/`-shm` sidecar is refused.
- `bun run db:preflight` validates a restored copy before migration (read-only).
- Never point tests at `data/bot.db`; the test harness uses temp databases and fails the run if anything under repo `data/` changes.

## Database commands

| Command | Script | Purpose |
|---|---|---|
| `bun run db:generate` | drizzle-kit | Generate a migration from `src/db/schema.ts`. Must leave no uncommitted drift. |
| `bun run db:check` | drizzle-kit | Validate migration journal/snapshots. |
| `bun run db:studio` | drizzle-kit | Open Drizzle Studio against the configured database (local dev only). |
| `bun run db:migrate` | `scripts/dbBackup.ts migrate` | Apply pending forward migrations via `ensureDatabaseSchema`. Does not back up first; run `db:backup` before it. |
| `bun run db:preflight` | `scripts/dbBackup.ts preflight` | Validate a restored copy before migration. |
| `bun run db:backup` | `scripts/dbBackup.ts backup` | Write a consistent `VACUUM INTO` snapshot. |
| `bun run db:restore` | `scripts/dbBackup.ts restore` | Restore from a backup (validates integrity/foreign keys/schema version). |
| `bun run db:room-keys` | `scripts/dbRoomKeys.ts` | Read-only report of canonical room-key coverage and conflicts. |
| `bun run db:room-keys:record` | `scripts/dbRoomKeys.ts --record-conflicts` | Record conflict audit rows. |
| `bun run db:embed` | `scripts/backfillEmbeddings.ts` | Re-embed stored memories after changing the embedding model. |
| `bun run db:retention` | `scripts/runRetention.ts` | Dry-run retention (default). Add `-- --apply` to delete. Refuses a path with no database file or one missing the retention tables, so a mistyped `ELASTRAX_DB_PATH` cannot create or target the wrong database. |

## Verification

```
bun run db:check
bun run db:generate        # must report no uncommitted drift
bun test --no-env-file test/migration.test.ts
bun test --no-env-file test/zz.db.index.test.ts
bun test --no-env-file test/dbBackup.test.ts
bun test --no-env-file test/dbRoomKeysScript.test.ts
```