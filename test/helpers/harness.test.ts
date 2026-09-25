import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertRepositoryDataUnchanged,
  assertSafeDatabasePath,
  captureRepositoryDataSnapshot,
  clearApplicationEnvironment,
  clearDotEnvLeakage,
  createTempDatabase,
  importFreshDatabaseModule,
  getTestWorkerPaths,
  installFetchMock,
  useFakeClock,
  withEnvironment,
  withIsolatedGlobals,
} from './index';
import { REPOSITORY_DATA_DIR, REPOSITORY_ROOT } from './paths';
import { saveTempMedia, cleanupTempMedia } from './tempMedia';

describe('hermetic test harness', () => {
  test('maps native optional modules to external fixtures', async () => {
    const signal = await import('libsignal');
    const bridge = await import('whatsapp-rust-bridge');
    if (typeof signal.SessionCipher !== 'function') throw new Error('libsignal fixture is not mapped');
    if (typeof bridge.expandAppStateKeys !== 'function') throw new Error('WhatsApp bridge fixture is not mapped');
  });

  test('uses a per-worker external path and rejects repository data paths', () => {
    const paths = getTestWorkerPaths();
    expect(paths.root).toStartWith('/tmp/');
    expect(paths.dbPath).toStartWith(paths.root);
    expect(paths.mediaDir).toStartWith(paths.root);
    expect(() => assertSafeDatabasePath(join(REPOSITORY_ROOT, 'data', 'bot.db'))).toThrow();
    expect(() => assertSafeDatabasePath(join(REPOSITORY_DATA_DIR, 'other.db'))).toThrow();
    const snapshot = captureRepositoryDataSnapshot();
    expect(snapshot.entries).toBeDefined();
    assertRepositoryDataUnchanged(snapshot);
  });

  test('removes dotenv application values without throwing away system paths', () => {
    const sample = { BOT_OWNER_JID: 'leaked', AI_TEST_SECRET: 'leaked', PATH: '/usr/bin' } as NodeJS.ProcessEnv;
    clearApplicationEnvironment(sample);
    clearDotEnvLeakage(sample);
    if (sample.BOT_OWNER_JID !== undefined) throw new Error('dotenv value leaked');
    if (sample.PATH !== '/usr/bin') throw new Error('system path was removed');
  });

  test('restores fake clocks and advances scheduled callbacks', () => {
    const before = Date.now();
    const clock = useFakeClock('2024-01-01T00:00:00.000Z');
    let fired = false;
    setTimeout(() => { fired = true; }, 25);
    expect(Date.now()).toBe(1704067200000);
    clock.advance(25);
    expect(fired).toBe(true);
    clock.restore();
    expect(Math.abs(Date.now() - before)).toBeLessThan(1000);
  });

  test('creates and cleans a temporary migrated database', async () => {
    const database = createTempDatabase();
    try {
      expect(database.path).toStartWith(getTestWorkerPaths().root);
      const tables = database.sqlite.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      expect(tables.some((row) => row.name === 'chat_rooms')).toBe(true);
    } finally {
      database.cleanup();
    }
  });

  test('loads the singleton database module only under a temporary path', async () => {
    const handle = await importFreshDatabaseModule('harness-self-test');
    try {
      const rows = handle.module.sqlite.query<{ file: string }, []>('PRAGMA database_list').all();
      if (!rows[0]?.file.startsWith(getTestWorkerPaths().root)) throw new Error('database module escaped the worker sandbox');
    } finally {
      handle.cleanup();
    }
  });

  test('redirects filesystem and Bun media writes to the worker sandbox', async () => {
    const specifier = '../../src/utils/MediaStorage.ts?harness-self-test';
    const mediaModule = await import(specifier) as typeof import('../../src/utils/MediaStorage');
    const saved = await mediaModule.saveMediaBuffer(Buffer.from('sandbox'));
    if (!saved) throw new Error('temporary media write failed');
    if ((await Bun.file(saved.path).arrayBuffer()).byteLength !== 7) throw new Error('media path was not redirected');
    const legacyPath = join(tmpdir(), 'elastrax-ffmpeg', 'harness-probe');
    await Bun.write(legacyPath, 'probe');
    if (await Bun.file(legacyPath).text() !== 'probe') throw new Error('legacy temp path was not redirected');
  });

  test('creates and cleans temporary media', async () => {
    const file = await saveTempMedia(Buffer.from('harness-media'));
    expect(file.path).toStartWith(getTestWorkerPaths().root);
    expect(file.bytes).toBe(13);
    cleanupTempMedia();
  });

  test('isolates timers, fetch, and environment together', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    await withIsolatedGlobals(async ({ timers, fetch: fetchMock }) => {
      setTimeout(() => {}, 1000);
      expect(timers.active()).toBe(1);
      await fetchMock('https://example.invalid');
    }, { fetch: async () => new Response('isolated') });
    expect(globalThis.setTimeout).toBe(originalSetTimeout);
  });

  test('isolates fetch and environment globals', async () => {
    const originalFetch = globalThis.fetch;
    const handle = installFetchMock(async () => new Response('ok'));
    await expect(globalThis.fetch('https://example.invalid')).resolves.toBeInstanceOf(Response);
    handle.restore();
    expect(globalThis.fetch).toBe(originalFetch);

    const previous = process.env.HARNESS_SELF_TEST;
    await withEnvironment({ HARNESS_SELF_TEST: 'isolated' }, async () => {
      expect(process.env.HARNESS_SELF_TEST).toBe('isolated');
    });
    if (previous === undefined) delete process.env.HARNESS_SELF_TEST;
    else process.env.HARNESS_SELF_TEST = previous;
  });

  test('prevents repository database reassignment through the env guard', () => {
    const original = process.env.ELASTRAX_DB_PATH;
    expect(() => { process.env.ELASTRAX_DB_PATH = join(REPOSITORY_DATA_DIR, 'bot.db'); }).toThrow();
    delete process.env.ELASTRAX_DB_PATH;
    if (original === undefined) {
      if (process.env.ELASTRAX_DB_PATH !== undefined) throw new Error('Database path was not cleared safely.');
    } else if (process.env.ELASTRAX_DB_PATH !== original) {
      throw new Error('Database path was not restored safely.');
    }
  });
});
