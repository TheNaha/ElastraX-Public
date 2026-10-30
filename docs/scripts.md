# Scripts and CLI Commands

All scripts run with Bun. Most are invoked via `package.json` scripts; some are direct entry points.

## Database and maintenance

| Command | Script | Purpose |
|---|---|---|
| `bun run db:generate` | drizzle-kit | Generate a migration from `src/db/schema.ts`. Must leave no uncommitted drift. |
| `bun run db:check` | drizzle-kit | Validate migration journal/snapshots. |
| `bun run db:migrate` | `scripts/dbBackup.ts migrate` | Apply forward migrations after a backup. |
| `bun run db:preflight` | `scripts/dbBackup.ts preflight` | Validate a restored copy before migration. |
| `bun run db:backup` | `scripts/dbBackup.ts backup` | Write a consistent `VACUUM INTO` snapshot. |
| `bun run db:restore` | `scripts/dbBackup.ts restore` | Restore from a backup (validates integrity/foreign keys/schema version). |
| `bun run db:room-keys` | `scripts/dbRoomKeys.ts` | Read-only report of canonical room-key coverage and conflicts. |
| `bun run db:room-keys:record` | `scripts/dbRoomKeys.ts --record-conflicts` | Record conflict audit rows. |
| `bun run db:embed` | `scripts/backfillEmbeddings.ts` | Re-embed stored memories after changing the embedding model. |
| `bun run db:retention` | `scripts/runRetention.ts` | Dry-run retention (default). Add `-- --apply` to delete. |

## Verification and diagnostics

| Command | Script | Purpose |
|---|---|---|
| `bun run check` | package.json | Lint + typecheck + tests + db:check. |
| `bun run lint` / `lint:fix` | eslint | Lint with `--max-warnings=0`. |
| `bun run typecheck` | tsc | Type check only. |
| `bun run test` | bun test | Full suite (use `--no-env-file`). |
| `bun run test:isolated` / `test:random` / `test:hermetic` | bun test | Isolated/randomized/hermetic runs. |
| `bun run test:webhooks` | bun test | Webhook + health subset. |
| `bun run test:coverage` | bun test | Coverage report. |
| `bun run ci:diagnose` | `scripts/ciDiagnostics.ts` | Read-only GitHub Actions triage (classifies runs). |
| `bun run provider:staging` | `scripts/providerStagingHarness.ts` | Credential-free provider contract harness. |

## Development helpers

| Command | Script | Purpose |
|---|---|---|
| `bun run start` | src/index.ts | Start the bot. |
| `bun run dev` | src/index.ts --watch | Watch mode. |
| `bun run fixtures:dump` | `scripts/dumpFixtures.ts` | Developer-only fixture dump (`ALLOW_FIXTURE_DUMP=true`). |
| `scripts/push-to-public.sh` | shell | Push helper (manual). |

## Notes

- `db:push` is intentionally disabled; use `db:migrate`.
- Retention defaults to dry-run; applying requires a verified backup and a stopped instance.
- `ciDiagnostics.ts` is read-only by construction and never spawns a mutating command.
