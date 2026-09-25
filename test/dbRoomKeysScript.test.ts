/**
 * test/dbRoomKeysScript.test.ts
 *
 * scripts/dbRoomKeys.ts must be safe to run against a live database: the default
 * report is strictly read-only, and only the explicit `--record-conflicts` flag
 * may append audit rows. Both run against a temporary database file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../src/core/constants';
import { ReadOnlyOpenError, openDatabase } from '../scripts/dbRoomKeys';
import { createTempDatabasePath, createTempDatabase, type TempDatabase } from './helpers/database';

const SCRIPT = join(ROOT_DIR, 'scripts/dbRoomKeys.ts');
const WA_ROOM = '6281234567890@s.whatsapp.net';

let database: TempDatabase;

function digest(): string {
  return createHash('sha256').update(readFileSync(database.path)).digest('hex');
}

async function runScript(args: string[] = []): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(['bun', 'run', SCRIPT, ...args], {
    cwd: ROOT_DIR,
    env: { ...process.env, ELASTRAX_DB_PATH: database.path, NODE_ENV: 'test' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  return { exitCode, stdout, stderr };
}

beforeEach(() => {
  database = createTempDatabase();
  database.sqlite.exec(`
    INSERT INTO chat_rooms (id, platform, created_at) VALUES ('${WA_ROOM}', 'whatsapp', 1000);
    INSERT INTO messages (chat_room_id, sender_id, sender_name, role, content, created_at)
      VALUES ('${WA_ROOM}', 'sender', 'Sender', 'user', 'hello', 1000);
    INSERT INTO user_roles (user_id, platform, scope, role, granted_by, created_at)
      VALUES ('sender', 'whatsapp', 'ghost-room', 'user', 'owner', 1000);
  `);
});

afterEach(() => {
  database.cleanup();
});

describe('db:room-keys report', () => {
  test('never falls back to a writable connection when the read-only open fails', () => {
    const attempts: Array<{ path: string; readonly?: boolean }> = [];
    const opener = {
      open(target: string, options: { readonly?: boolean }) {
        attempts.push({ path: target, readonly: options.readonly });
        throw new Error('unable to open database file');
      },
    };

    expect(() => openDatabase('/tmp/elastrax-live.db', false, opener)).toThrow(ReadOnlyOpenError);
    expect(() => openDatabase('/tmp/elastrax-live.db', false, opener)).toThrow(/Refusing to open .* for writing/);
    expect(() => openDatabase('/tmp/elastrax-live.db', false, opener)).toThrow(
      /Stop the running bot .* or re-run with --record-conflicts/s,
    );
    // Exactly one attempt per call, always read-only: no writable retry.
    expect(attempts).toHaveLength(3);
    expect(attempts.every(attempt => attempt.readonly === true)).toBe(true);
  });

  test('opens read/write only when conflict recording was requested', () => {
    const attempts: Array<boolean | undefined> = [];
    const handle = new Database(':memory:', { create: true, strict: true });
    try {
      const opener = {
        open(_target: string, options: { readonly?: boolean }) {
          attempts.push(options.readonly);
          return handle;
        },
      };
      expect(openDatabase('/tmp/elastrax-live.db', true, opener).readOnly).toBe(false);
      expect(openDatabase('/tmp/elastrax-live.db', false, opener).readOnly).toBe(true);
      expect(attempts).toEqual([undefined, true]);
    } finally {
      handle.close();
    }
  });

  test('fails without writing when the database cannot be opened read-only', async () => {
    const missing = createTempDatabasePath('room-keys-missing.db');
    const child = Bun.spawn(['bun', 'run', SCRIPT], {
      cwd: ROOT_DIR,
      env: { ...process.env, ELASTRAX_DB_PATH: missing, NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(child.stderr).text();
    const exitCode = await child.exited;

    expect(exitCode).toBe(2);
    expect(stderr).toContain('Refusing to open');
    expect(stderr).toContain('read-only open failed');
    expect(stderr).toContain('--record-conflicts');
  });

  test('fails without writing when the file is not a database', async () => {
    const notADatabase = createTempDatabasePath('room-keys-report.txt');
    writeFileSync(notADatabase, 'this is not a sqlite database\n');
    const before = readFileSync(notADatabase);
    const child = Bun.spawn(['bun', 'run', SCRIPT], {
      cwd: ROOT_DIR,
      env: { ...process.env, ELASTRAX_DB_PATH: notADatabase, NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(child.stderr).text();
    const exitCode = await child.exited;

    expect(exitCode).toBe(2);
    expect(stderr).toContain('Cannot read the room identity report');
    expect(stderr).toContain('Nothing was written');
    expect(stderr).toContain('--record-conflicts');
    // No writable fallback ran, so the file is byte-identical afterwards.
    expect(readFileSync(notADatabase)).toEqual(before);
  });

  test('reports coverage and collisions without touching the database', async () => {
    const before = digest();
    const result = await runScript();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('migration 0022_room_keys (when=23)');
    expect(result.stdout).toContain('room_keys rows');
    expect(result.stdout).toContain('messages.room_key');
    expect(result.stdout).toContain('coverage complete         : yes');
    expect(result.stdout).toContain('unresolved_scope');
    expect(result.stdout).not.toContain('room identity is consistent');
    expect(digest()).toBe(before);
  });

  test('emits machine-readable output on request', async () => {
    const result = await runScript(['--json']);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      readOnly: boolean;
      migration: { tag: string; when: number };
      stats: { roomKeys: number; coverageIsComplete: boolean };
      collisions: Array<{ kind: string }>;
    };
    expect(payload.readOnly).toBe(true);
    expect(payload.migration).toEqual({ tag: '0022_room_keys', when: 23 });
    expect(payload.stats.roomKeys).toBe(1);
    expect(payload.stats.coverageIsComplete).toBe(true);
    expect(payload.collisions.map(collision => collision.kind)).toEqual(['unresolved_scope']);
  });

  test('only the explicit flag writes audit rows, and it stays idempotent', async () => {
    const first = await runScript(['--record-conflicts']);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('audit rows written: 1');
    expect(
      database.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM room_key_conflicts').get()?.count,
    ).toBe(1);

    const second = await runScript(['--record-conflicts']);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('audit rows written: 0');
    expect(
      database.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM room_key_conflicts').get()?.count,
    ).toBe(1);

    // Application data is never touched by the audit pass.
    expect(database.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM chat_rooms').get()?.count).toBe(1);
    expect(database.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM messages').get()?.count).toBe(1);
  });
});
