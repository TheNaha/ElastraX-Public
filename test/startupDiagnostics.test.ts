import { describe, test, expect, mock, afterEach } from 'bun:test';
import * as path from 'path';
import { withEnvironment } from './helpers/env';

const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};

mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

import { dumpFixtures, resolveFixtureDir, runStartupCoverageScan, stripFixtureBlobs } from '../src/runtime/startupDiagnostics';

type DiagnosticsDeps = NonNullable<Parameters<typeof dumpFixtures>[1]>;

const allowDump = { NODE_ENV: 'test', ALLOW_FIXTURE_DUMP: 'true' } as const;

const emptyCoverage = {
  uniqueByType: new Map(),
  errors: [],
  unknownSamples: [],
  total: 0,
};

describe('startupDiagnostics', () => {
  afterEach(() => {
    delete process.env.ALLOW_FIXTURE_DUMP;
  });

  test('resolveFixtureDir prefers configured directory', async () => {
    await withEnvironment({ FIXTURE_DUMP_DIR: 'custom/fixtures' }, () => {
      expect(resolveFixtureDir()).toBe('custom/fixtures');
    });
  });

  test('resolveFixtureDir defaults to the sanitized fixture directory in every environment', async () => {
    await withEnvironment({ FIXTURE_DUMP_DIR: undefined, NODE_ENV: 'development' }, () => {
      expect(resolveFixtureDir()).toContain(path.join('test', 'fixtures', 'wa_messages'));
    });

    await withEnvironment({ FIXTURE_DUMP_DIR: undefined, NODE_ENV: 'production' }, () => {
      expect(resolveFixtureDir()).toContain(path.join('test', 'fixtures', 'wa_messages'));
    });
  });

  test('stripFixtureBlobs removes large binary blob fields recursively', () => {
    const raw = {
      jpegThumbnail: 'thumb',
      message: {
        imageMessage: {
          fileSha256: 'hash',
          caption: 'hello',
        },
      },
      nested: [{ messageSecret: 'secret', ok: true }],
    };

    expect(stripFixtureBlobs(raw)).toEqual({
      message: { imageMessage: { caption: 'hello' } },
      nested: [{ ok: true }],
    });
  });

  test('dumpFixtures refuses to run in production even when explicitly allowed', async () => {
    await withEnvironment({ ...allowDump, NODE_ENV: 'production' }, async () => {
      await expect(dumpFixtures(null, { loadMessages: () => [{ rawMessage: '{}', providerMessageId: 'm1' }] }))
        .rejects.toThrow('Fixture dumping is disabled outside an explicit development environment');
    });
  });

  test('dumpFixtures refuses to run without an explicit opt-in flag', async () => {
    await withEnvironment({ NODE_ENV: 'test', ALLOW_FIXTURE_DUMP: undefined }, async () => {
      await expect(dumpFixtures(null, { loadMessages: () => [{ rawMessage: '{}', providerMessageId: 'm1' }] }))
        .rejects.toThrow('Fixture dumping is disabled outside an explicit development environment');
    });
  });

  test('dumpFixtures never touches the database or filesystem when it refuses', async () => {
    const loadMessages = mock(() => [{ rawMessage: '{}', providerMessageId: 'm1' }]);
    const writeTextFile = mock(async () => {});
    const makeDirectory = mock(async () => {});

    await withEnvironment({ ...allowDump, NODE_ENV: 'production' }, async () => {
      await expect(dumpFixtures(null, {
        loadMessages,
        makeDirectory,
        writeTextFile,
      } as unknown as DiagnosticsDeps)).rejects.toThrow('Fixture dumping is disabled outside an explicit development environment');
    });

    expect(loadMessages).not.toHaveBeenCalled();
    expect(makeDirectory).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  test('dumpFixtures writes one file per unique type and preserves existing files', async () => {
    const loadMessages = mock(() => [{ rawMessage: '{}', providerMessageId: 'm1' }]);
    const scanCoverage = mock(async () => ({
      uniqueByType: new Map([
        ['conversation', { raw: { text: 'hello', jpegThumbnail: 'ignore' }, parsed: { messageType: 'conversation' } }],
        ['imageMessage', { raw: { nested: { fileSha256: 'ignore', caption: 'photo' } }, parsed: { messageType: 'imageMessage' } }],
      ]),
      errors: [],
      unknownSamples: [],
      total: 1,
    }));
    const logCoverage = mock(() => {});
    const makeDirectory = mock(async () => {});
    const writeTextFile = mock(async () => {});
    const fileExists = mock((filePath: string) => filePath.endsWith('conversation.json'));

    await withEnvironment({ ...allowDump, FIXTURE_DUMP_DIR: 'tmp-fixtures' }, async () => {
      await dumpFixtures(null, {
        loadMessages,
        scanCoverage,
        logCoverage,
        makeDirectory,
        writeTextFile,
        fileExists,
      } as unknown as DiagnosticsDeps);
    });

    expect(loadMessages).toHaveBeenCalledTimes(1);
    expect(scanCoverage).toHaveBeenCalledTimes(1);
    expect(logCoverage).toHaveBeenCalledTimes(1);
    expect(makeDirectory).toHaveBeenCalledWith('tmp-fixtures', { recursive: true, mode: 0o700 });
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(writeTextFile).toHaveBeenCalledWith(
      expect.stringContaining('imageMessage.json'),
      JSON.stringify({ nested: { caption: 'photo' } }, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
  });

  test('dumpFixtures returns early when no rows are loaded', async () => {
    const loadMessages = mock(() => []);
    const scanCoverage = mock(async () => emptyCoverage);

    await withEnvironment(allowDump, async () => {
      await dumpFixtures(null, { loadMessages, scanCoverage } as unknown as DiagnosticsDeps);
    });

    expect(loadMessages).toHaveBeenCalledTimes(1);
    expect(scanCoverage).not.toHaveBeenCalled();
  });

  test('dumpFixtures swallows unwritable fixture directories', async () => {
    const loadMessages = mock(() => [{ rawMessage: '{}', providerMessageId: 'm1' }]);
    const scanCoverage = mock(async () => ({
      uniqueByType: new Map([['conversation', { raw: { text: 'hello' }, parsed: { messageType: 'conversation' } }]]),
      errors: [],
      unknownSamples: [],
      total: 1,
    }));
    const makeDirectory = mock(async () => {
      const error = new Error('no access') as Error & { code?: string };
      error.code = 'EACCES';
      throw error;
    });
    const writeTextFile = mock(async () => {});

    await withEnvironment(allowDump, async () => {
      await expect(dumpFixtures(null, {
        loadMessages,
        scanCoverage,
        makeDirectory,
        writeTextFile,
      } as unknown as DiagnosticsDeps)).resolves.toBeUndefined();
    });
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  test('dumpFixtures stops when writing becomes read-only', async () => {
    const loadMessages = mock(() => [{ rawMessage: '{}', providerMessageId: 'm1' }]);
    const scanCoverage = mock(async () => ({
      uniqueByType: new Map([['conversation', { raw: { text: 'hello' }, parsed: { messageType: 'conversation' } }]]),
      errors: [{ rowId: 'm1', error: 'bad parse' }],
      unknownSamples: [],
      total: 1,
    }));
    const writeTextFile = mock(async () => {
      const error = new Error('read only') as Error & { code?: string };
      error.code = 'EROFS';
      throw error;
    });

    await withEnvironment(allowDump, async () => {
      await expect(dumpFixtures(null, {
        loadMessages,
        scanCoverage,
        makeDirectory: mock(async () => {}),
        writeTextFile,
        fileExists: mock(() => false),
      } as unknown as DiagnosticsDeps)).resolves.toBeUndefined();
    });

    expect(writeTextFile).toHaveBeenCalledTimes(1);
  });

  test('runStartupCoverageScan limits row loading and logs coverage when rows exist', async () => {
    const loadMessages = mock((_limit?: number) => [{ rawMessage: '{}', providerMessageId: 'm1' }]);
    const scanCoverage = mock(async () => ({
      uniqueByType: new Map(),
      errors: [],
      unknownSamples: [],
      total: 1,
    }));
    const logCoverage = mock(() => {});

    await runStartupCoverageScan(null, { loadMessages, scanCoverage, logCoverage } as unknown as DiagnosticsDeps);

    expect(loadMessages).toHaveBeenCalledWith(2000);
    expect(scanCoverage).toHaveBeenCalledTimes(1);
    expect(logCoverage).toHaveBeenCalledTimes(1);
  });

  test('runStartupCoverageScan swallows scan failures', async () => {
    const loadMessages = mock(() => [{ rawMessage: '{}', providerMessageId: 'm1' }]);
    const scanCoverage = mock(async () => {
      throw new Error('scan failed');
    });

    await expect(runStartupCoverageScan(null, { loadMessages, scanCoverage } as unknown as DiagnosticsDeps)).resolves.toBeUndefined();
  });

  test('runStartupCoverageScan returns early when no rows exist', async () => {
    const loadMessages = mock((_limit?: number) => []);
    const scanCoverage = mock(async () => emptyCoverage);

    await runStartupCoverageScan(null, { loadMessages, scanCoverage } as unknown as DiagnosticsDeps);

    expect(loadMessages).toHaveBeenCalledWith(2000);
    expect(scanCoverage).not.toHaveBeenCalled();
  });

  test('runStartupCoverageScan never dumps fixtures regardless of the dump opt-in', async () => {
    const writeTextFile = mock(async () => {});

    await withEnvironment(allowDump, async () => {
      await runStartupCoverageScan(null, {
        loadMessages: () => [{ rawMessage: '{}', providerMessageId: 'm1' }],
        scanCoverage: async () => ({
          uniqueByType: new Map([['conversation', { raw: { text: 'hello' }, parsed: { messageType: 'conversation' } }]]),
          errors: [],
          unknownSamples: [],
          total: 1,
        }),
        writeTextFile,
      } as unknown as DiagnosticsDeps);
    });

    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
