import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

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
    expect(resolveFixtureDir()).toContain('test\\fixtures\\wa_messages');

    process.env.NODE_ENV = 'production';
    expect(resolveFixtureDir()).toContain('data\\fixtures\\wa_messages');
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
    });

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
});