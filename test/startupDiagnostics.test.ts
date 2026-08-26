import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';

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

describe('startupDiagnostics', () => {
  const originalFixtureDir = process.env.FIXTURE_DUMP_DIR;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    delete process.env.FIXTURE_DUMP_DIR;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalFixtureDir === undefined) {
      delete process.env.FIXTURE_DUMP_DIR;
    } else {
      process.env.FIXTURE_DUMP_DIR = originalFixtureDir;
    }

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test('resolveFixtureDir prefers configured directory', () => {
    process.env.FIXTURE_DUMP_DIR = 'custom/fixtures';
    expect(resolveFixtureDir()).toBe('custom/fixtures');
  });

  test('resolveFixtureDir switches between development and production defaults', () => {
    process.env.NODE_ENV = 'development';
    expect(resolveFixtureDir()).toContain(path.join('test', 'fixtures', 'wa_messages'));

    process.env.NODE_ENV = 'production';
    expect(resolveFixtureDir()).toContain(path.join('data', 'fixtures', 'wa_messages'));
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

    process.env.FIXTURE_DUMP_DIR = 'tmp-fixtures';

    await dumpFixtures(null, {
      loadMessages,
      scanCoverage,
      logCoverage,
      makeDirectory,
      writeTextFile,
      fileExists,
    } as unknown as DiagnosticsDeps);

    expect(loadMessages).toHaveBeenCalledTimes(1);
    expect(scanCoverage).toHaveBeenCalledTimes(1);
    expect(logCoverage).toHaveBeenCalledTimes(1);
    expect(makeDirectory).toHaveBeenCalledWith('tmp-fixtures', { recursive: true });
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(writeTextFile).toHaveBeenCalledWith(
      expect.stringContaining('imageMessage.json'),
      JSON.stringify({ nested: { caption: 'photo' } }, null, 2),
      'utf-8',
    );
  });

  test('dumpFixtures returns early when no rows are loaded', async () => {
    const loadMessages = mock(() => []);
    const scanCoverage = mock(async () => ({
      uniqueByType: new Map(),
      errors: [],
      unknownSamples: [],
      total: 0,
    }));

    await dumpFixtures(null, { loadMessages, scanCoverage });

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

    await expect(dumpFixtures(null, {
      loadMessages,
      scanCoverage,
      makeDirectory,
      writeTextFile,
    } as unknown as DiagnosticsDeps)).resolves.toBeUndefined();
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

    await expect(dumpFixtures(null, {
      loadMessages,
      scanCoverage,
      makeDirectory: mock(async () => {}),
      writeTextFile,
      fileExists: mock(() => false),
    } as unknown as DiagnosticsDeps)).resolves.toBeUndefined();

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

    await runStartupCoverageScan(null, { loadMessages, scanCoverage, logCoverage });

    expect(loadMessages).toHaveBeenCalledWith(2000);
    expect(scanCoverage).toHaveBeenCalledTimes(1);
    expect(logCoverage).toHaveBeenCalledTimes(1);
  });

  test('runStartupCoverageScan swallows scan failures', async () => {
    const loadMessages = mock(() => [{ rawMessage: '{}', providerMessageId: 'm1' }]);
    const scanCoverage = mock(async () => {
      throw new Error('scan failed');
    });

    await expect(runStartupCoverageScan(null, { loadMessages, scanCoverage })).resolves.toBeUndefined();
  });

  test('runStartupCoverageScan returns early when no rows exist', async () => {
    const loadMessages = mock((_limit?: number) => []);
    const scanCoverage = mock(async () => ({
      uniqueByType: new Map(),
      errors: [],
      unknownSamples: [],
      total: 0,
    }));

    await runStartupCoverageScan(null, { loadMessages, scanCoverage });

    expect(loadMessages).toHaveBeenCalledWith(2000);
    expect(scanCoverage).not.toHaveBeenCalled();
  });
});