/**
 * test/rooms.catalog.test.ts
 *
 * Room-key resolution probes the SQLite schema catalog (`sqlite_master`,
 * `pragma_table_xinfo`) to tolerate an unmigrated database. That probe ran three
 * or four times per inbound message and sixteen times per `getRoomKeyStats`
 * call. The catalog can only change during a migration, so it is memoised per
 * handle and dropped by the `afterMigrationCallbacks` hook.
 *
 * These tests pin both halves: the second identical resolve must not re-read the
 * catalog, and an invalidation must make the cache see a schema change.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  getRoomKeyStats,
  invalidateRoomCatalogCache,
  resolveOrCreateRoomKeySync,
  resolveRoomKeySync,
} from '../src/db/rooms';
import { createTempDatabase, type TempDatabase } from './helpers/database';

const ROOM = '6281234567890@s.whatsapp.net';

let database: TempDatabase;
let sqlite: Database;
let originalQuery: Database['query'];
let catalogQueries: string[];

function isCatalogQuery(sql: string): boolean {
  return sql.includes('sqlite_master') || sql.includes('pragma_table_xinfo');
}

beforeEach(() => {
  database = createTempDatabase({ memory: true });
  sqlite = database.sqlite;
  catalogQueries = [];
  originalQuery = sqlite.query.bind(sqlite);
  sqlite.query = ((sql: string) => {
    if (isCatalogQuery(sql)) catalogQueries.push(sql);
    return originalQuery(sql);
  }) as Database['query'];
  invalidateRoomCatalogCache();
});

afterEach(() => {
  sqlite.query = originalQuery;
  database.cleanup();
});

describe('room schema catalog cache', () => {
  test('a repeated resolve does not re-read the schema catalog', () => {
    const first = resolveOrCreateRoomKeySync('whatsapp', ROOM, { sqlite });
    const probesAfterFirst = catalogQueries.length;
    expect(probesAfterFirst).toBeGreaterThan(0);

    const second = resolveOrCreateRoomKeySync('whatsapp', ROOM, { sqlite });

    expect(second.roomKey).toBe(first.roomKey);
    expect(second.created).toBe(false);
    expect(catalogQueries.length).toBe(probesAfterFirst);
  });

  test('read-only resolution is served from the cache too', () => {
    const created = resolveOrCreateRoomKeySync('whatsapp', ROOM, { sqlite });
    const probes = catalogQueries.length;

    for (let i = 0; i < 5; i++) {
      expect(resolveRoomKeySync('whatsapp', ROOM, sqlite)).toBe(created.roomKey);
    }
    expect(catalogQueries.length).toBe(probes);
  });

  test('room-key stats reuse the memoised column probes', () => {
    resolveOrCreateRoomKeySync('whatsapp', ROOM, { sqlite });
    // The first stats call has to warm the probes for the tables the resolve did
    // not touch; the second must be served entirely from the cache.
    getRoomKeyStats(sqlite);
    const warmProbes = catalogQueries.length;

    getRoomKeyStats(sqlite);
    expect(catalogQueries.length).toBe(warmProbes);
  });

  test('invalidation makes a schema change visible again', () => {
    const unmigrated = createTempDatabase({ memory: true, migrate: false });
    try {
      const handle = unmigrated.sqlite;
      expect(resolveRoomKeySync('whatsapp', ROOM, handle)).toBeNull();

      handle.exec(
        'CREATE TABLE room_keys (room_key TEXT PRIMARY KEY, platform TEXT, remote_room_id TEXT, legacy_room_id TEXT, created_at INTEGER)',
      );
      handle
        .query('INSERT INTO room_keys (room_key, platform, remote_room_id, legacy_room_id, created_at) VALUES (?, ?, ?, NULL, ?)')
        .run('room:whatsapp:6281234567890@s.whatsapp.net', 'whatsapp', ROOM, 1);

      // Without invalidation the negative result for `room_keys` is sticky.
      expect(resolveRoomKeySync('whatsapp', ROOM, handle)).toBeNull();

      invalidateRoomCatalogCache();
      expect(resolveRoomKeySync('whatsapp', ROOM, handle)).toBe('room:whatsapp:6281234567890@s.whatsapp.net');
    } finally {
      unmigrated.cleanup();
    }
  });
});
