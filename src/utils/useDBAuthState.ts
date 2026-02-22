import { AuthenticationState, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { db } from '../db';
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
      if (records.length > 0) {
        // We stored it as a JSON string, let's parse it correctly with Baileys' reviver 
        // Note: text('data', { mode: 'json' }) automatically parses regular JSON, 
        // but Baileys has custom Buffer reviving. If Drizzle Auto-parsed it, we re-stringify and revive.
        const parsed = typeof records[0].data === 'string' 
          ? JSON.parse(records[0].data as string, BufferJSON.reviver)
          : JSON.parse(JSON.stringify(records[0].data), BufferJSON.reviver);
        return parsed;
      }
      return null;
    } catch (e) {
      return null;
    }
  };

  // Utility for writing data to SQLite
  const writeData = async (data: any, id: string): Promise<void> => {
    try {
      // Stringify using Baileys' replacer, so Drizzle inserting it as a JSON mode text column
      // receives the perfectly formatted object (or we can just store the raw string)
      const dataString = JSON.stringify(data, BufferJSON.replacer);
      // Drizzle's text({mode: 'json'}) expects a Javascript Object and will stringify it normally.
      // But since Baileys has a custom replacer stringifier, we should bypass Drizzle's auto-stringify 
      // by just casting the JSON string to `any` because SQLite ultimately just wants a string.
      await db.insert(waAuthState).values({ id, data: JSON.parse(dataString) })
        .onConflictDoUpdate({
          target: waAuthState.id,
          set: { data: JSON.parse(dataString) },
        });
    } catch (e) {
      // ignore
    }
  };

  const removeData = async (id: string): Promise<void> => {
    try {
      await db.delete(waAuthState).where(eq(waAuthState.id, id));
    } catch (e) {
      // ignore
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
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const catData = data[category] as any;
            for (const id in catData) {
              const value = catData[id];
              const fileId = `${category}-${id}`;
              tasks.push(value ? writeData(value, fileId) : removeData(fileId));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      return writeData(creds, 'creds');
    },
  };
};
