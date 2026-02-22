import { AuthenticationState, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { db } from '../db';
import { logger } from './logger';
import { waAuthState } from '../db/schema';
import { eq } from 'drizzle-orm';
import { BufferJSON } from '@whiskeysockets/baileys/lib/Utils/generics';

export const useDBAuthState = async (): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> => {
  // Utility for reading data from SQLite
  const readData = async (id: string): Promise<any | null> => {
    try {
      const records = await db.select().from(waAuthState).where(eq(waAuthState.id, id)).limit(1);
      if (records.length > 0 && records[0].data) {
        // Drizzle reads the JSON/string back. Baileys requires BufferJSON.reviver to reconstruct proto objects.
        const dataStr = typeof records[0].data === 'string' ? records[0].data : JSON.stringify(records[0].data);
        return JSON.parse(dataStr, BufferJSON.reviver);
      }
      return null;
    } catch (e) {
      return null;
    }
  };

  // Utility for writing data to SQLite
  const writeData = async (data: any, id: string): Promise<void> => {
    try {
      // Baileys has heavily complex Buffers inside its state. We MUST use BufferJSON.replacer
      // Drizzle's `mode: 'json'` expects a raw object and stringifies natively, skipping the replacer.
      // So we must manually stringify it here, and store the raw string, treating the SQLite column dynamically.
      const stringified = JSON.stringify(data, BufferJSON.replacer);
      // Wait, Drizzle mode='json' will try to `JSON.parse` whatever we pass it. If we pass a string, it might double-parse or crash.
      // Actually, if we pass a pre-stringified string to Drizzle mode=json, we can just `JSON.parse` it right back into an object
      // so Drizzle stringifies it again into the DB. BUT we lose Buffer tracking!
      // Better approach: Since waAuthState.data is `text({ mode: 'json' })`, let's just let it be text!
      // But we can't change the schema now easily without a migration.
      // So let's pass the object wrapped back up via JSON.parse of the replacer output.
      const parsedObject = JSON.parse(stringified);
      
      await db.insert(waAuthState).values({ id, data: parsedObject })
        .onConflictDoUpdate({
          target: waAuthState.id,
          set: { data: parsedObject },
        });
    } catch (e) {
      logger.error({ id, e }, 'Failed to save auth state data to SQLite');
    }
  };

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
