/**
 * @file src/utils/useDBAuthState.ts
 * @description SQLite-backed Baileys authentication state adapter.
 *
 * Baileys (the WhatsApp library) requires a persistent key-value store for:
 *  - `creds` — The device registration credentials (analogous to a login session).
 *  - Signal Protocol session keys — Keyed as `"${category}-${id}"` (e.g.,
 *    `"app-state-sync-key-XYZ"`, `"session-628xxx"`, etc.).
 *
 * The default Baileys adapter writes these to JSON files on disk.  This adapter
 * stores them in the `wa_auth_state` SQLite table instead, so:
 *  - No extra volume mount is needed in Docker for `/auth_info_baileys/`.
 *  - Credentials and session keys survive container restarts automatically.
 *  - Everything stays in the single `bot.db` file that is already being backed up.
 *
 * Serialisation note:
 *  Baileys auth data contains `Buffer` objects that must be serialised with
 *  `BufferJSON.replacer` and deserialised with `BufferJSON.reviver`.  Standard
 *  `JSON.stringify/parse` silently corrupts Buffers into plain objects, causing
 *  "No session to decrypt" errors.  This adapter handles that correctly.
 */

import { AuthenticationState, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { db } from '../db';
import { logger } from './logger';
import { waAuthState } from '../db/schema';
import { eq } from 'drizzle-orm';
import { BufferJSON } from '@whiskeysockets/baileys/lib/Utils/generics';

/**
 * Creates and returns a Baileys-compatible `AuthenticationState` that reads/writes
 * credentials to the `wa_auth_state` SQLite table.
 *
 * @returns An object containing:
 *   - `state` — The `AuthenticationState` to pass to `makeWASocket({ auth: state })`.
 *   - `saveCreds` — A callback to pass to the `creds.update` Baileys event so that
 *     credential changes are persisted immediately.
 */
export const useDBAuthState = async (): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> => {
  /**
   * Reads a single Baileys key/value pair from the database.
   * Returns the parsed value (with Buffers restored via BufferJSON.reviver),
   * or `null` if the key does not exist or the stored data is malformed.
   */
  const readData = async (id: string): Promise<any | null> => {
    try {
      const records = await db.select().from(waAuthState).where(eq(waAuthState.id, id)).limit(1);
      if (records.length > 0 && records[0].data) {
        // Drizzle reads the JSON/string back. Baileys requires BufferJSON.reviver to reconstruct proto objects.
        const dataStr = typeof records[0].data === 'string' ? records[0].data : JSON.stringify(records[0].data);
        return JSON.parse(dataStr, BufferJSON.reviver);
      }
      return null;
    } catch {
      return null;
    }
  };

  /**
   * Persists a Baileys key/value pair to the database using an upsert.
   * MUST use `BufferJSON.replacer` when stringifying to correctly serialise
   * Baileys' Buffer-typed fields (Signal Protocol keys, etc.).
   */
  const writeData = async (data: any, id: string): Promise<void> => {
    try {
      // Baileys has heavily complex Buffers inside its state. We MUST use BufferJSON.replacer
      // Drizzle's `mode: 'json'` expects a raw object and stringifies natively, skipping the replacer.
      // So we must manually stringify it here, and store the raw string, treating the SQLite column dynamically.
      const stringified = JSON.stringify(data, BufferJSON.replacer);
      // We must pass the raw string into SQLite. 
      // Drizzle's schema for `waAuthState.data` is now `text()` without `mode: json`!
      await db.insert(waAuthState).values({ id, data: stringified })
        .onConflictDoUpdate({
          target: waAuthState.id,
          set: { data: stringified },
        });
    } catch (e) {
      logger.error({ id, e }, 'Failed to save auth state data to SQLite');
    }
  };

  /** Removes a key from the auth state table (called when Baileys invalidates a session key). */
  const removeData = async (id: string): Promise<void> => {
    try {
      await db.delete(waAuthState).where(eq(waAuthState.id, id));
    } catch (e) {
      logger.error({ id, e }, 'Failed to remove auth state data from SQLite');
    }
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [key: string]: any } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data: any) => {
          const tasks: (() => Promise<void>)[] = [];
          for (const category in data) {
            const catData = data[category] as any;
            for (const id in catData) {
              const value = catData[id];
              const fileId = `${category}-${id}`;
              // Queue them as thunks so we can await them sequentially to avoid SQLITE_BUSY locks
              tasks.push(() => (value ? writeData(value, fileId) : removeData(fileId)));
            }
          }
          for (const task of tasks) {
            await task();
          }
        },
      },
    },
    saveCreds: async () => {
      return writeData(creds, 'creds');
    },
  };
};
