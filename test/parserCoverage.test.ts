import { describe, test, expect, mock, spyOn, afterEach } from 'bun:test';

mock.module('../src/utils/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

import { scanParserCoverage, logCoverageSummary } from '../src/utils/parserCoverage';
import * as whatsappParser from '../src/providers/whatsappParser';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeRow = (
  overrides: Partial<{ rawMessage: string | null; providerMessageId: string | null }> = {},
) => ({
  rawMessage: JSON.stringify({ key: { id: 'msg-1' }, message: { conversation: 'hello' } }),
  providerMessageId: 'msg-1',
  ...overrides,
});

// ─── scanParserCoverage ───────────────────────────────────────────────────────

describe('scanParserCoverage', () => {
  afterEach(() => {
    // Restore any spies to avoid cross-test contamination
    spyOn(whatsappParser, 'parseWhatsAppMessage').mockRestore();
  });

  test('should return empty result for empty rows array', async () => {
    const result = await scanParserCoverage([], null);
    expect(result.total).toBe(0);
    expect(result.uniqueByType.size).toBe(0);
    expect(result.errors.length).toBe(0);
    expect(result.unknownSamples.length).toBe(0);
  });

  test('should skip rows with null rawMessage', async () => {
    const rows = [makeRow({ rawMessage: null })];
    const result = await scanParserCoverage(rows, null);
    expect(result.total).toBe(0);
  });

  test('should skip rows with invalid JSON in rawMessage', async () => {
    const rows = [makeRow({ rawMessage: 'not-valid-json' })];
    const result = await scanParserCoverage(rows, null);
    expect(result.total).toBe(0);
  });

  test('should parse valid rows and track unique types', async () => {
    const rows = [
      makeRow({ rawMessage: JSON.stringify({ key: { id: 'm1' }, message: { conversation: 'hi' } }) }),
      makeRow({ rawMessage: JSON.stringify({ key: { id: 'm2' }, message: { imageMessage: { caption: '', url: 'x', mimetype: 'image/jpeg' } } }) }),
      makeRow({ rawMessage: JSON.stringify({ key: { id: 'm3' }, message: { conversation: 'bye' } }) }),
    ];
    const result = await scanParserCoverage(rows, null);
    expect(result.total).toBe(3);
    expect(result.uniqueByType.size).toBe(2);
    expect(result.uniqueByType.has('conversation')).toBe(true);
    expect(result.uniqueByType.has('imageMessage')).toBe(true);
  });

  test('should record errors when parser throws', async () => {
    // Spy on the real function and make it throw for one call
    const spy = spyOn(whatsappParser, 'parseWhatsAppMessage').mockImplementationOnce(
      async () => { throw new Error('Parser error'); },
    );

    const rows = [makeRow()];
    const result = await scanParserCoverage(rows, null);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error.message).toBe('Parser error');
    expect(result.errors[0].index).toBe(0);

    spy.mockRestore();
  });

  test('should record unknownSamples when messageType is "unknown"', async () => {
    // A message with an unrecognized structure → parser returns 'unknown'
    const rows = [makeRow({ rawMessage: JSON.stringify({ key: { id: 'unk' }, message: { __unrecognized: true } }) })];
    const result = await scanParserCoverage(rows, null);
    expect(result.unknownSamples.length).toBe(1);
    expect(result.unknownSamples[0].index).toBe(0);
    expect(result.uniqueByType.has('unknown')).toBe(true);
  });

  test('should store the raw message and parsed result in uniqueByType', async () => {
    const rawObj = { key: { id: 'audio-1' }, message: { audioMessage: { url: 'x', mimetype: 'audio/ogg', seconds: 5 } } };
    const rows = [makeRow({ rawMessage: JSON.stringify(rawObj) })];
    const result = await scanParserCoverage(rows, null);
    const entry = result.uniqueByType.get('audioMessage');
    expect(entry).toBeDefined();
    expect(entry!.parsed.messageType).toBe('audioMessage');
  });

  test('should handle a mix of valid, errored, and unknown rows', async () => {
    const spy = spyOn(whatsappParser, 'parseWhatsAppMessage')
      .mockImplementationOnce(async () => ({ messageType: 'conversation', text: 'hi', hasMedia: false, mentionedIds: [], quoted: undefined }))
      .mockImplementationOnce(async () => { throw new Error('boom'); })
      .mockImplementationOnce(async () => ({ messageType: 'unknown', text: '', hasMedia: false, mentionedIds: [], quoted: undefined }));

    const rows = [makeRow(), makeRow(), makeRow()];
    const result = await scanParserCoverage(rows, null);
    expect(result.total).toBe(3);
    expect(result.uniqueByType.size).toBe(2); // 'conversation' + 'unknown'
    expect(result.errors.length).toBe(1);
    expect(result.unknownSamples.length).toBe(1);

    spy.mockRestore();
  });

  test('should pass botUserId to the parser', async () => {
    const spy = spyOn(whatsappParser, 'parseWhatsAppMessage');

    const rows = [makeRow()];
    await scanParserCoverage(rows, '6281999@s.whatsapp.net');

    expect(spy).toHaveBeenCalled();
    const firstArg1 = spy.mock.calls[0]?.[1];
    expect(firstArg1).toBe('6281999@s.whatsapp.net');

    spy.mockRestore();
  });
});

// ─── logCoverageSummary ───────────────────────────────────────────────────────

describe('logCoverageSummary', () => {
  test('should not throw for an empty result', () => {
    const result = {
      uniqueByType: new Map(),
      errors: [],
      unknownSamples: [],
      total: 0,
    };
    expect(() => logCoverageSummary(result)).not.toThrow();
  });

  test('should not throw for a result with multiple types and errors', () => {
    const result = {
      uniqueByType: new Map([
        ['conversation', { raw: {}, parsed: { messageType: 'conversation', text: '', hasMedia: false, mentionedIds: [], quoted: undefined } }],
        ['imageMessage', { raw: {}, parsed: { messageType: 'imageMessage', text: '', hasMedia: true, mentionedIds: [], quoted: undefined } }],
      ]),
      errors: [
        { index: 2, raw: {}, error: new Error('parse fail') },
        { index: 3, raw: {}, error: new Error('another fail') },
        { index: 4, raw: {}, error: new Error('fail 3') },
        { index: 5, raw: {}, error: new Error('fail 4') },
        { index: 6, raw: {}, error: new Error('fail 5') },
        { index: 7, raw: {}, error: new Error('fail 6') }, // > 5, should truncate
      ],
      unknownSamples: [{ index: 10, raw: {} }],
      total: 10,
    };
    expect(() => logCoverageSummary(result)).not.toThrow();
  });

  test('should not throw when there are no errors but unknownSamples exist', () => {
    const result = {
      uniqueByType: new Map([
        ['unknown', { raw: {}, parsed: { messageType: 'unknown', text: '', hasMedia: false, mentionedIds: [], quoted: undefined } }],
      ]),
      errors: [],
      unknownSamples: [{ index: 0, raw: {} }, { index: 1, raw: {} }],
      total: 2,
    };
    expect(() => logCoverageSummary(result)).not.toThrow();
  });
});
