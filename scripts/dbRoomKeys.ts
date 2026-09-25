/**
 * @file scripts/dbRoomKeys.ts
 * @description Read-only canonical room identity report.
 *
 * Prints the room key registry state, per-table `room_key` row coverage, and every
 * room identity ambiguity that is currently visible. The default mode opens the
 * database read-only and never falls back to a writable connection, so it is safe
 * to run against a live bot database at any time.
 *
 *   bun run db:room-keys                 # read-only report (default)
 *   bun run db:room-keys -- --json       # machine-readable output
 *   bun run db:room-keys -- --limit 25   # cap the per-collision sample
 *   bun run db:room-keys -- --record-conflicts   # MUTATES: open read/write and persist audit rows
 *
 * `--record-conflicts` is the only mode that opens the database for writing; it
 * appends `room_key_conflicts` rows (idempotent, keyed by fingerprint) and never
 * touches application data.
 */

import { Database } from 'bun:sqlite';
import { resolveDatabasePath } from '../src/config/database';
import {
  ROOM_KEY_MIGRATION_TAG,
  ROOM_KEY_MIGRATION_WHEN,
  findRoomKeyCollisions,
  getRoomKeyStats,
  type RoomKeyCollision,
  type RoomKeyStats,
} from '../src/db/rooms';

interface Options {
  json: boolean;
  limit: number;
  recordConflicts: boolean;
}

function parseOptions(argv: string[]): Options {
  const limitIndex = argv.indexOf('--limit');
  const parsedLimit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : Number.NaN;
  return {
    json: argv.includes('--json'),
    limit: Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20,
    recordConflicts: argv.includes('--record-conflicts'),
  };
}

/** Thrown when the report cannot be produced without opening the database for writing. */
export class ReadOnlyOpenError extends Error {
  override readonly name = 'ReadOnlyOpenError';
}

export interface DatabaseOpener {
  open(path: string, options: { readonly?: boolean; create?: boolean; strict: boolean }): Database;
}

/**
 * Open the report database.
 *
 * The default path is strictly read-only: there is no writable fallback, because a
 * silent fallback would let a "read-only" report perform WAL recovery on a live bot
 * database. When the read-only open fails the operator is told what to do instead.
 * `--record-conflicts` is the only mode that opens the database for writing.
 */
export function openDatabase(
  path: string,
  allowWrite: boolean,
  deps: DatabaseOpener = { open: (target, options) => new Database(target, options) },
): { sqlite: Database; readOnly: boolean } {
  if (allowWrite) {
    return { sqlite: deps.open(path, { create: false, strict: true }), readOnly: false };
  }
  try {
    return { sqlite: deps.open(path, { readonly: true, strict: true }), readOnly: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ReadOnlyOpenError(
      `Refusing to open ${path} for writing: the read-only open failed (${reason}). ` +
        'Stop the running bot (or restore/point at a consistent database copy) so the WAL can be recovered, ' +
        'or re-run with --record-conflicts to open read/write and persist the audit rows.',
    );
  }
}

function recordConflicts(sqlite: Database, collisions: RoomKeyCollision[]): number {
  const now = Date.now();
  const insert = sqlite.query<never, [string, string, string, string | null, string | null, string | null, string, string, number]>(
    `INSERT OR IGNORE INTO room_key_conflicts
       (fingerprint, conflict_type, platform, room_key, remote_room_id, legacy_room_id, details, detected_by, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let recorded = 0;
  for (const collision of collisions) {
    if (collision.kind.startsWith('recorded:')) continue;
    const platform = collision.platform ?? '';
    const fingerprint = [
      'audit',
      collision.kind,
      platform,
      collision.table ?? '',
      collision.rowId ?? '',
      collision.roomKey ?? '',
      collision.remoteRoomId ?? '',
      collision.legacyRoomId ?? '',
    ].join('|');
    const result = insert.run(
      fingerprint,
      collision.kind,
      platform,
      collision.roomKey,
      collision.remoteRoomId,
      collision.legacyRoomId,
      collision.detail,
      'script:dbRoomKeys',
      now,
    );
    recorded += Number(result.changes);
  }
  return recorded;
}

function printHuman(options: Options, stats: RoomKeyStats, collisions: RoomKeyCollision[], readOnly: boolean, recorded: number): void {
  console.log(`[db:room-keys] migration ${ROOM_KEY_MIGRATION_TAG} (when=${ROOM_KEY_MIGRATION_WHEN})`);
  console.log(`[db:room-keys] connection: ${readOnly ? 'read-only' : 'read/write (no writes issued)'}`);
  console.log('[db:room-keys] registry');
  console.log(`  room_keys rows            : ${stats.roomKeys}`);
  console.log(`  with legacy room id       : ${stats.withLegacyRoomId}`);
  console.log(`  chat_rooms rows           : ${stats.chatRooms}`);
  console.log(`  unregistered chat rooms   : ${stats.unregisteredChatRooms}`);
  console.log(`  non-transparent keys      : ${stats.nonTransparentRoomKeys}`);
  console.log(`  derived-key collisions    : ${stats.derivedKeyCollisions}`);
  console.log(`  audit rows / unresolved   : ${stats.conflicts} / ${stats.unresolvedConflicts}`);
  console.log('[db:room-keys] row coverage');
  for (const entry of stats.coverage) {
    const percent = entry.total === 0 ? 100 : Math.round((entry.withRoomKey / entry.total) * 100);
    const suffix = entry.optional ? ' (null allowed)' : '';
    console.log(
      `  ${`${entry.table}.${entry.column}`.padEnd(38)} ${entry.withRoomKey}/${entry.total} (${percent}%)${suffix}`,
    );
  }
  console.log(`  coverage complete         : ${stats.coverageIsComplete ? 'yes' : 'no'}`);
  console.log(`[db:room-keys] collisions: ${collisions.length}`);
  for (const collision of collisions.slice(0, options.limit)) {
    const target = [collision.table, collision.rowId].filter(Boolean).join('#') || '-';
    console.log(
      `  ${collision.kind} ${target} platform=${collision.platform ?? '-'} roomKey=${collision.roomKey ?? '-'} :: ${collision.detail}`,
    );
  }
  if (collisions.length > options.limit) {
    console.log(`  ... ${collisions.length - options.limit} more (raise --limit to see them)`);
  }
  if (options.recordConflicts) console.log(`[db:room-keys] audit rows written: ${recorded}`);
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const options = parseOptions(argv);
  const path = resolveDatabasePath();
  const { sqlite, readOnly } = openDatabase(path, options.recordConflicts);
  try {
    const stats = getRoomKeyStats(sqlite);
    const collisions = findRoomKeyCollisions(sqlite);
    const recorded = options.recordConflicts ? recordConflicts(sqlite, collisions) : 0;
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            path,
            readOnly,
            migration: { tag: ROOM_KEY_MIGRATION_TAG, when: ROOM_KEY_MIGRATION_WHEN },
            recordedConflicts: recorded,
            stats,
            collisions,
          },
          null,
          2,
        ),
      );
      return;
    }
    printHuman(options, stats, collisions, readOnly, recorded);
    if (stats.coverageIsComplete && collisions.length === 0) {
      console.log('[db:room-keys] room identity is consistent');
    }
  } finally {
    sqlite.close();
  }
}

const UNREADABLE_DATABASE = /not a database|unable to open|database is locked|readonly|read-only|database disk image is malformed|malformed/i;

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const path = resolveDatabasePath();
    if (error instanceof ReadOnlyOpenError) {
      console.error(`[db:room-keys] ${error.message}`);
      process.exit(2);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (UNREADABLE_DATABASE.test(message)) {
      console.error(
        `[db:room-keys] Cannot read the room identity report from ${path}: ${message}\n` +
          '[db:room-keys] Nothing was written. Stop the running bot (or point at a consistent database copy) so ' +
          'the WAL can be recovered, or re-run with --record-conflicts to open read/write and persist audit rows.',
      );
      process.exit(2);
    }
    throw error;
  }
}
