/**
 * test/roomLanguage.test.ts
 *
 * `getRoomLanguage` is the single lookup behind reminder text, digest labels and
 * webhook fan-out — every surface rendered outside a `MessageContext`. It had no
 * direct coverage, so a change to the key/raw-id fallback could only have failed
 * indirectly.
 */

import { afterEach, describe, test, expect } from 'bun:test';
import { db, sqlite } from '../src/db';
import { chatRooms } from '../src/db/schema';
import { getRoomLanguage } from '../src/db/roomLanguage';

// Every test uses its own room ids so this file never touches rows another
// parallel test file in the same worker database depends on (deleting a room
// referenced by a flow session fails the foreign key).
const RUN = Math.random().toString(36).slice(2, 8);
const created: string[] = [];

function newRoomKey(): string {
  return `room:whatsapp:roomlang-${RUN}-${Math.random().toString(36).slice(2, 8)}`;
}

function seedRoom(id: string, language: string, roomKey: string | null): void {
  db.insert(chatRooms).values({
    id,
    platform: 'whatsapp',
    language,
    roomKey,
    created_at: new Date(),
  }).run();
  created.push(id);
}

afterEach(() => {
  for (const id of created.splice(0)) {
    sqlite.query<never, [string]>('DELETE FROM chat_rooms WHERE id = ?').run(id);
  }
});

describe('getRoomLanguage', () => {
  test('reads the language of a canonical room key', () => {
    const key = newRoomKey();
    seedRoom(key, 'id', key);
    expect(getRoomLanguage(key)).toBe('id');
  });

  test('falls back to the raw remote id for rows written before the key migration', () => {
    const key = newRoomKey();
    const remote = key.slice('room:whatsapp:'.length);
    seedRoom(remote, 'id', null);
    expect(getRoomLanguage(key)).toBe('id');
  });

  test('accepts a raw id as the argument', () => {
    const key = newRoomKey();
    const remote = key.slice('room:whatsapp:'.length);
    seedRoom(remote, 'id', key);
    expect(getRoomLanguage(remote)).toBe('id');
  });

  test('returns null for an unknown room so callers keep their own default', () => {
    expect(getRoomLanguage(`room:whatsapp:missing-${RUN}`)).toBeNull();
  });
});
