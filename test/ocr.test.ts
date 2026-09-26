/**
 * Tests for vision-based knowledge-base ingestion.
 *
 * The transcription cleaner is the part most likely to silently corrupt the
 * knowledge base: a chat model wraps verbatim output in fences and preambles,
 * and anything that survives into `ingestRoomDocument` becomes permanent
 * searchable room state. Those cases are pinned directly.
 */
import { describe, test, expect, mock } from 'bun:test';

// ModelRouter is replaced at module level so transcription is exercised end to
// end without a network call, and the call arguments can be inspected.
let nextReply = 'transcribed body text';
let nextError: Error | null = null;
let lastArgs: unknown[] = [];

mock.module('../src/utils/ModelRouter', () => ({
  getModelRouter: () => ({
    chatCompletion: async (...args: unknown[]) => {
      lastArgs = args;
      if (nextError) throw nextError;
      return { content: nextReply };
    },
  }),
  ModelRouter: class {},
}));

const { cleanTranscription, readOcrConfig, isTranscribableMime, transcribeImage } = await import('../src/utils/ocr');

describe('cleanTranscription', () => {
  test('returns trimmed text unchanged', () => {
    expect(cleanTranscription('  hello world  ')).toBe('hello world');
  });

  test('strips a fenced code block', () => {
    expect(cleanTranscription('```text\nINVOICE TOTAL 42\n```')).toBe('INVOICE TOTAL 42');
    expect(cleanTranscription('```\nplain\n```')).toBe('plain');
  });

  test('strips a chatty preamble', () => {
    expect(cleanTranscription("Here's the transcription:\nTOTAL: 99")).toBe('TOTAL: 99');
    expect(cleanTranscription('Transcription: line one')).toBe('line one');
    expect(cleanTranscription('Extracted text: line one')).toBe('line one');
  });

  test('treats an explicit no-text reply as empty', () => {
    // This is the contract the prompt asks for, and it must not become a
    // one-word document in the knowledge base.
    expect(cleanTranscription('NO_TEXT')).toBe('');
    expect(cleanTranscription('no text')).toBe('');
    expect(cleanTranscription('NO_TEXT.')).toBe('');
  });

  test('returns empty for blank input', () => {
    expect(cleanTranscription('')).toBe('');
    expect(cleanTranscription('   \n  ')).toBe('');
  });

  test('preserves internal structure including markdown tables', () => {
    const table = '| Item | Cost |\n| --- | --- |\n| Rent | 1200 |';
    expect(cleanTranscription(table)).toBe(table);
  });

  test('keeps numbers, dates and codes exact', () => {
    const invoice = 'INV-2026-0042  Due 2026-02-01  Total 1,299.00 USD  ref:AB12CD34';
    expect(cleanTranscription(invoice)).toBe(invoice);
  });
});

describe('readOcrConfig', () => {
  test('is enabled by default', () => {
    expect(readOcrConfig({} as NodeJS.ProcessEnv).enabled).toBe(true);
  });

  test('honours an explicit disable', () => {
    for (const value of ['0', 'false', 'no', 'off']) {
      expect(readOcrConfig({ KB_OCR_ENABLED: value } as NodeJS.ProcessEnv).enabled).toBe(false);
    }
  });

  test('rejects out-of-range limits', () => {
    const config = readOcrConfig({ KB_OCR_MAX_BYTES: '1', KB_OCR_MAX_OUTPUT_TOKENS: '99999999' } as NodeJS.ProcessEnv);
    expect(config.maxBytes).toBe(8 * 1024 * 1024);
    expect(config.maxOutputTokens).toBe(2_048);
  });
});

describe('isTranscribableMime', () => {
  test('accepts images and PDFs', () => {
    expect(isTranscribableMime('image/png')).toBe(true);
    expect(isTranscribableMime('image/jpeg; charset=binary')).toBe(true);
    expect(isTranscribableMime('application/pdf')).toBe(true);
  });

  test('rejects everything else', () => {
    expect(isTranscribableMime('text/plain')).toBe(false);
    expect(isTranscribableMime('video/mp4')).toBe(false);
    expect(isTranscribableMime('')).toBe(false);
  });
});

describe('transcribeImage', () => {
  const image = Buffer.from('fake-png-bytes');
  const config = { enabled: true, maxBytes: 1024 * 1024, maxOutputTokens: 512, tier: 'standard' as const };

  test('sends the image as a vision content block and returns the cleaned text', async () => {
    nextReply = '```\nMEETING NOTES\nBudget approved\n```';
    const result = await transcribeImage(image, 'image/png', { config });
    expect(result.text).toBe('MEETING NOTES\nBudget approved');
    expect(result.empty).toBe(false);

    const [messages] = lastArgs as [Array<{ content: unknown }>];
    const content = messages[0]!.content as Array<{ type: string }>;
    expect(content.map(part => part.type)).toEqual(['text', 'image_url']);
  });

  test('reports empty when the model finds no text', async () => {
    nextReply = 'NO_TEXT';
    const result = await transcribeImage(image, 'image/png', { config });
    expect(result.empty).toBe(true);
    expect(result.text).toBe('');
  });

  test('refuses an empty buffer', async () => {
    await expect(transcribeImage(Buffer.alloc(0), 'image/png', { config })).rejects.toThrow(/empty/i);
  });

  test('refuses an image over the size cap', async () => {
    const small = { ...config, maxBytes: 8 }; // below the fake image's 15 bytes
    await expect(transcribeImage(image, 'image/png', { config: small })).rejects.toThrow(/OCR limit/);
  });

  test('refuses when OCR is disabled', async () => {
    await expect(transcribeImage(image, 'image/png', { config: { ...config, enabled: false } }))
      .rejects.toThrow(/disabled/i);
  });

  test('propagates a model failure rather than indexing an empty document', async () => {
    nextError = new Error('vision model unavailable');
    try {
      await expect(transcribeImage(image, 'image/png', { config })).rejects.toThrow(/vision model unavailable/);
    } finally {
      nextError = null;
    }
  });
});
