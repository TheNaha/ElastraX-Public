import { AuthenticationState, initAuthCreds, proto, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import { BufferJSON } from '@whiskeysockets/baileys/lib/Utils/generics';
import { eq, inArray } from 'drizzle-orm';
import { db, sqlite, withImmediateTransaction } from '../db';
import { waAuthState } from '../db/schema';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger';

type SignalDataSet = Parameters<AuthenticationState['keys']['set']>[0];
type SerializableAuthValue = AuthenticationState['creds'] | SignalDataTypeMap[keyof SignalDataTypeMap];

export const useDBAuthState = async (): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> => {
  let mutationQueue: Promise<void> = Promise.resolve();

  const enqueueMutation = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(() => {}, () => {});
    return result;
  };

  const readData = async (id: string): Promise<unknown | null> => {
    const records = await db.select().from(waAuthState).where(eq(waAuthState.id, id)).limit(1);
    if (records.length === 0 || !records[0].data) return null;
    try {
      const data = typeof records[0].data === 'string' ? records[0].data : JSON.stringify(records[0].data);
      return JSON.parse(data, BufferJSON.reviver);
    } catch (error) {
      // Deliberately fail closed: `AppRuntime` starts providers with
      // `allSettled`, so this disables WhatsApp with a clear log line while the
      // other platforms keep working. Treating an unreadable credential as
      // "absent" would silently re-pair the device, which is a bigger surprise
      // than an actionable startup error. Recovery: delete the `creds` row (or
      // restore a backup) and pair again.
      logger.error({ id, err: error }, 'Corrupt WhatsApp auth state row');
      throw new Error(`Corrupt WhatsApp auth state row: ${id}`, { cause: error });
    }
  };

  const writeBatch = (entries: Array<{ id: string; data: SerializableAuthValue }>, removals: string[]): void => {
    const serialized = entries.map(entry => ({
      id: entry.id,
      data: JSON.stringify(entry.data, BufferJSON.replacer),
    }));
    withImmediateTransaction(sqlite, () => {
      for (const id of removals) {
        db.delete(waAuthState).where(eq(waAuthState.id, id)).run();
      }
      for (const entry of serialized) {
        db.insert(waAuthState)
          .values(entry)
          .onConflictDoUpdate({ target: waAuthState.id, set: { data: entry.data } })
          .run();
      }
    });
  };

  const importLegacyState = async (directory: string): Promise<AuthenticationState['creds']> => {
    const credsPath = join(directory, 'creds.json');
    const creds = JSON.parse(
      await readFile(credsPath, 'utf8'),
      BufferJSON.reviver,
    ) as AuthenticationState['creds'];
    const entries: Array<{ id: string; data: SerializableAuthValue }> = [{ id: 'creds', data: creds }];
    const files = await readdir(directory);
    for (const file of files.filter(name => name.startsWith('app-state-sync-key-') && name.endsWith('.json'))) {
      const value = JSON.parse(await readFile(join(directory, file), 'utf8'), BufferJSON.reviver) as SignalDataTypeMap['app-state-sync-key'];
      entries.push({ id: `app-state-sync-key-${file.slice('app-state-sync-key-'.length, -'.json'.length)}`, data: value });
    }
    await enqueueMutation(() => writeBatch(entries, []));
    logger.info({ entryCount: entries.length }, 'Imported legacy WhatsApp auth state');
    return creds;
  };

  const storedCreds = await readData('creds') as AuthenticationState['creds'] | null;
  const legacyDirectory = process.env.WA_AUTH_IMPORT_DIR?.trim();
  const creds = storedCreds
    ?? (legacyDirectory ? await importLegacyState(legacyDirectory) : null)
    ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data = {} as { [id: string]: SignalDataTypeMap[T] };
          if (ids.length === 0) return data;
          // One query for the batch instead of one per id. Baileys requests
          // session and pre-key *sets* on every send/receive, so the per-id
          // `readData` calls made the crypto path N round trips through Drizzle
          // for a single lookup.
          const rows = await db
            .select({ id: waAuthState.id, data: waAuthState.data })
            .from(waAuthState)
            .where(inArray(waAuthState.id, ids.map(id => `${type}-${id}`)));
          const stored = new Map(rows.map(row => [row.id, row.data] as const));
          for (const id of ids) {
            const raw = stored.get(`${type}-${id}`);
            let value: SignalDataTypeMap[T] | null = null;
            if (raw !== undefined && raw !== null && raw !== '') {
              try {
                value = JSON.parse(raw, BufferJSON.reviver) as SignalDataTypeMap[T];
              } catch (error) {
                logger.error({ id: `${type}-${id}`, err: error }, 'Corrupt WhatsApp auth state row');
                throw new Error(`Corrupt WhatsApp auth state row: ${type}-${id}`, { cause: error });
              }
            }
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as Record<string, unknown>,
              ) as unknown as SignalDataTypeMap[T];
            }
            data[id] = value as SignalDataTypeMap[T];
          }
          return data;
        },
        set: async data => {
          const entries: Array<{ id: string; data: SerializableAuthValue }> = [];
          const removals: string[] = [];
          for (const category in data) {
            const categoryData = data[category as keyof SignalDataSet];
            if (!categoryData) continue;
            for (const id in categoryData) {
              const value = categoryData[id];
              const fileId = `${String(category)}-${id}`;
              if (value) entries.push({ id: fileId, data: value as SerializableAuthValue });
              else removals.push(fileId);
            }
          }
          await enqueueMutation(() => writeBatch(entries, removals));
        },
      },
    },
    saveCreds: () => enqueueMutation(() => writeBatch([{ id: 'creds', data: creds }], [])),
  };
};
