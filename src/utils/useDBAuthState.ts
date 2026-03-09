import { AuthenticationState, initAuthCreds, proto, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import { BufferJSON } from '@whiskeysockets/baileys/lib/Utils/generics';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { waAuthState } from '../db/schema';
import { logger } from './logger';

type SignalDataSet = Parameters<AuthenticationState['keys']['set']>[0];

type SerializableAuthValue = AuthenticationState['creds'] | SignalDataTypeMap[keyof SignalDataTypeMap];

export const useDBAuthState = async (): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> => {
  const readData = async (id: string): Promise<unknown | null> => {
    try {
      const records = await db.select().from(waAuthState).where(eq(waAuthState.id, id)).limit(1);
      if (records.length > 0 && records[0].data) {
        const dataStr = typeof records[0].data === 'string' ? records[0].data : JSON.stringify(records[0].data);
        return JSON.parse(dataStr, BufferJSON.reviver);
      }
      return null;
    } catch {
      return null;
    }
  };

  const writeData = async (data: SerializableAuthValue, id: string): Promise<void> => {
    try {
      const stringified = JSON.stringify(data, BufferJSON.replacer);
      await db.insert(waAuthState).values({ id, data: stringified })
        .onConflictDoUpdate({
          target: waAuthState.id,
          set: { data: stringified },
        });
    } catch (error) {
      logger.error({ id, error }, 'Failed to save auth state data to SQLite');
    }
  };

  const removeData = async (id: string): Promise<void> => {
    try {
      await db.delete(waAuthState).where(eq(waAuthState.id, id));
    } catch (error) {
      logger.error({ id, error }, 'Failed to remove auth state data from SQLite');
    }
  };

  const creds = ((await readData('creds')) as AuthenticationState['creds'] | null) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data = {} as { [id: string]: SignalDataTypeMap[T] };
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`) as SignalDataTypeMap[T] | null;
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(
                  value as Record<string, unknown>,
                ) as unknown as SignalDataTypeMap[T];
              }
              data[id] = value as SignalDataTypeMap[T];
            }),
          );
          return data;
        },
        set: async (data: SignalDataSet) => {
          const tasks: Array<() => Promise<void>> = [];
          for (const category of Object.keys(data) as Array<keyof SignalDataSet>) {
            const catData = data[category];
            if (!catData) continue;
            for (const id of Object.keys(catData)) {
              const value = catData[id];
              const fileId = `${String(category)}-${id}`;
              tasks.push(() => (value ? writeData(value as SerializableAuthValue, fileId) : removeData(fileId)));
            }
          }
          for (const task of tasks) {
            await task();
          }
        },
      },
    },
    saveCreds: async () => writeData(creds, 'creds'),
  };
};

