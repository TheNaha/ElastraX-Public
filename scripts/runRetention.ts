import { existsSync } from 'node:fs';
import { resolveDatabasePath } from '../src/config/database';

const apply = process.argv.includes('--apply');

/**
 * Refuse to touch a database that is not the bot's.
 *
 * The database handle opens in create mode, so a typo in `ELASTRAX_DB_PATH`
 * used to create an empty file, start a retention pass against it, and only then
 * fail on `no such table: messages` — leaving the stray database behind. With
 * `--apply` the same typo is a delete against an empty database, and with a
 * *valid but wrong* path it deletes another deployment's rows. Check before the
 * handle is opened; the schema check below catches a file that exists but is not
 * migrated.
 */
const databasePath = resolveDatabasePath(process.env);
if (databasePath !== ':memory:' && !existsSync(databasePath)) {
  console.error(`Refusing to run retention: no database at ${databasePath}`);
  process.exit(1);
}

const [{ runRetentionMaintenance }, { sqlite }, { tableExists }] = await Promise.all([
  import('../src/db/maintenance'),
  import('../src/db'),
  import('../src/db/runtime'),
]);

for (const table of ['messages', 'message_inbox', 'message_outbox', 'flow_sessions']) {
  if (!tableExists(sqlite, table)) {
    console.error(`Refusing to run retention: ${databasePath} has no "${table}" table (not a migrated bot database?)`);
    process.exit(1);
  }
}

const result = runRetentionMaintenance({ dryRun: !apply });
console.log(JSON.stringify(result, null, 2));
