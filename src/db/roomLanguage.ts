/**
 * @file src/db/roomLanguage.ts
 * @description Room language lookup.
 *
 * Reminders and webhook notifications are rendered outside a `MessageContext`,
 * so they cannot read `ctx.language`. Both need the same answer — the language
 * stored on the room row — and both used to carry their own copy of the query.
 * Keeping it here means a room that switches language is picked up by every
 * outbound path at once.
 */

import { eq } from 'drizzle-orm';
import { db } from './index';
import { chatRooms } from './schema';
import { remoteRoomIdFromKey } from '../messaging/roomKeys';
import { logger } from '../utils/logger';

/**
 * Language of a room, addressed by its canonical room key.
 *
 * Rows written before the canonical-key migration still carry the raw remote id
 * in `chat_rooms.id`, so that form is tried as well. Returns `null` when the
 * room is unknown, which lets callers fall back to their own default.
 */
export function getRoomLanguage(roomKey: string): string | null {
  const remote = remoteRoomIdFromKey(roomKey);
  try {
    const byKey = db.select({ language: chatRooms.language })
      .from(chatRooms)
      .where(eq(chatRooms.roomKey, roomKey))
      .all()[0];
    if (byKey?.language) return byKey.language;
    for (const candidate of remote ? [remote] : [roomKey]) {
      const row = db.select({ language: chatRooms.language })
        .from(chatRooms)
        .where(eq(chatRooms.id, candidate))
        .all()[0];
      if (row?.language) return row.language;
    }
  } catch (error) {
    logger.warn({ err: error, roomKey }, '[roomLanguage] Room configuration lookup failed');
  }
  return null;
}
