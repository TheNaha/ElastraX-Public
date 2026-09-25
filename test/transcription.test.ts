import { afterEach, describe, expect, test, mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  requestTranscription,
  resolveTranscriptionSource,
  transcribeSource,
  transcriptionDeps,
  validateAudioBuffer,
} from '../src/utils/transcription';
import type { MessageContext } from '../src/core/MessageContext';

const ogg = (): Buffer => Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);

describe('transcription helpers', () => {
  afterEach(() => {
    transcriptionDeps.runProcess = undefined;
  });

  test('sends validated audio as multipart without a base64 JSON body', async () => {
    let captured: RequestInit | undefined;
    const fetchSuccess = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ text: 'hello world' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await requestTranscription(
      ogg(),
      'application/octet-stream',
      'en',
      fetchSuccess as unknown as typeof fetch,
      { TRANSCRIBE_ENDPOINT: 'https://stt.example', TRANSCRIBE_TIMEOUT_MS: '1000' },
    );

    expect(result).toBe('hello world');
    expect(captured?.body).toBeInstanceOf(FormData);
    const form = captured?.body as FormData;
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(form.get('language')).toBe('en');
    expect((captured?.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  test('supports the legacy JSON transport explicitly', async () => {
    const fetchSuccess = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { audio_base64: string; mime_type: string };
      expect(body.mime_type).toBe('audio/ogg');
      expect(body.audio_base64.length).toBeGreaterThan(0);
      return new Response(JSON.stringify({ transcript: 'legacy result' }), { status: 200 });
    });

    await expect(requestTranscription(
      ogg(),
      'audio/ogg',
      'en',
      fetchSuccess as unknown as typeof fetch,
      { TRANSCRIBE_ENDPOINT: 'https://stt.example', TRANSCRIBE_TIMEOUT_MS: '1000' },
      { mode: 'json' },
    )).resolves.toBe('legacy result');
  });

  test('rejects empty transcripts and HTTP failures', async () => {
    const empty = mock(async () => new Response(JSON.stringify({ text: '' }), { status: 200 }));
    await expect(requestTranscription(ogg(), 'audio/ogg', 'en', empty as unknown as typeof fetch, { TRANSCRIBE_ENDPOINT: 'https://stt.example' })).rejects.toThrow('Empty transcript');

    const failed = mock(async () => new Response('no', { status: 503 }));
    await expect(requestTranscription(ogg(), 'audio/ogg', 'en', failed as unknown as typeof fetch, { TRANSCRIBE_ENDPOINT: 'https://stt.example' })).rejects.toThrow('HTTP 503');
  });

  test('uses ffprobe for unknown declared-audio content and requires an audio stream', async () => {
    transcriptionDeps.runProcess = mock(async () => ({ stdout: Buffer.from(JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'opus' }] })) }));
    await expect(validateAudioBuffer(Buffer.from('unknown-audio'), 'application/octet-stream')).resolves.toBe('audio/opus');

    transcriptionDeps.runProcess = mock(async () => ({ stdout: Buffer.from(JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264' }] })) }));
    await expect(validateAudioBuffer(Buffer.from('not-audio'), 'application/octet-stream')).rejects.toThrow('no audio stream');
  });

  test('rejects non-audio content before probing', async () => {
    await expect(validateAudioBuffer(Buffer.from('%PDF-1.7'), 'application/pdf')).rejects.toThrow('not audio');
  });

  test('transcribeSource reads a bounded file and delegates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'transcription-test-'));
    const mediaPath = join(directory, 'voice.ogg');
    try {
      await writeFile(mediaPath, ogg(), { mode: 0o600 });
      const fetchSuccess = mock(async () => new Response(JSON.stringify({ text: 'from file' }), { status: 200 }));
      await expect(transcribeSource(
        { mediaPath, mimeType: 'audio/ogg' },
        'en',
        fetchSuccess as unknown as typeof fetch,
        { TRANSCRIBE_ENDPOINT: 'https://stt.example' },
      )).resolves.toBe('from file');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('resolveTranscriptionSource prefers current media and gates quoted fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'transcription-source-'));
    const currentPath = join(directory, 'current.ogg');
    const quotedPath = join(directory, 'quoted.ogg');
    try {
      await writeFile(currentPath, ogg(), { mode: 0o600 });
      await writeFile(quotedPath, ogg(), { mode: 0o600 });
      const ctx = {
        mediaReady: Promise.resolve(),
        mediaPath: currentPath,
        mimeType: 'audio/ogg',
        quoted: {
          mediaPath: quotedPath,
          mimeType: 'audio/ogg',
        },
        messageType: 'audioMessage',
      } as unknown as MessageContext;

      await expect(resolveTranscriptionSource(ctx, true)).resolves.toEqual({ mediaPath: currentPath, mimeType: 'audio/ogg' });
      await expect(resolveTranscriptionSource(ctx, false)).resolves.toEqual({ mediaPath: currentPath, mimeType: 'audio/ogg' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects a source without a concrete path', async () => {
    const ctx = { mediaReady: Promise.resolve(), quoted: {} } as unknown as MessageContext;
    await expect(resolveTranscriptionSource(ctx, true)).resolves.toBeNull();
  });
});
