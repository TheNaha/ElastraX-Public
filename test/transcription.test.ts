import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import type { MessageContext } from '../src/core/MessageContext';
import {
  isAudioMimeType,
  isTranscriptionConfigured,
  requestTranscription,
  resolveTranscriptionSource,
  transcribeSource,
} from '../src/utils/transcription';

describe('transcription helpers', () => {
  let existsSpy: ReturnType<typeof spyOn>;
  let readFileSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue(Buffer.from('audio-bytes') as any);
  });

  afterEach(() => {
    existsSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  test('detects supported audio mime types and configuration state', () => {
    expect(isAudioMimeType('audio/ogg')).toBe(true);
    expect(isAudioMimeType('video/mp4')).toBe(false);
    expect(isTranscriptionConfigured({ TRANSCRIBE_ENDPOINT: 'https://stt.example' })).toBe(true);
    expect(isTranscriptionConfigured({ TRANSCRIBE_ENDPOINT: '' })).toBe(false);
  });

  test('resolveTranscriptionSource prefers current media and can fall back to quoted media', async () => {
    const ctx = {
      mediaReady: Promise.resolve(),
      mediaPath: '/tmp/current.ogg',
      mimeType: 'audio/ogg',
      quoted: {
        mediaPath: '/tmp/quoted.ogg',
        mimeType: 'audio/mpeg',
      },
    } as MessageContext;

    const direct = await resolveTranscriptionSource(ctx, true);
    expect(direct).toEqual({ mediaPath: '/tmp/current.ogg', mimeType: 'audio/ogg' });

    existsSpy.mockImplementation((value: fs.PathLike) => String(value).includes('quoted'));
    const fallback = await resolveTranscriptionSource({
      ...ctx,
      mediaPath: undefined,
    } as MessageContext, true);
    expect(fallback).toEqual({ mediaPath: '/tmp/quoted.ogg', mimeType: 'audio/mpeg' });
  });

  test('requestTranscription returns transcripts and rejects bad responses', async () => {
    const fetchSuccess = mock(async () => ({
      ok: true,
      json: async () => ({ text: 'hello world' }),
    })) as any;
    const fetchFailure = mock(async () => ({
      ok: false,
      status: 502,
    })) as any;
    const fetchEmpty = mock(async () => ({
      ok: true,
      json: async () => ({ text: '   ' }),
    })) as any;

    await expect(
      requestTranscription(
        Buffer.from('audio'),
        'audio/ogg',
        'en',
        fetchSuccess,
        { TRANSCRIBE_ENDPOINT: 'https://stt.example', TRANSCRIBE_TIMEOUT_MS: '1000' },
      ),
    ).resolves.toBe('hello world');
    await expect(
      requestTranscription(
        Buffer.from('audio'),
        'audio/ogg',
        'en',
        fetchFailure,
        { TRANSCRIBE_ENDPOINT: 'https://stt.example', TRANSCRIBE_TIMEOUT_MS: '1000' },
      ),
    ).rejects.toThrow('HTTP 502');
    await expect(
      requestTranscription(
        Buffer.from('audio'),
        'audio/ogg',
        'en',
        fetchEmpty,
        { TRANSCRIBE_ENDPOINT: 'https://stt.example', TRANSCRIBE_TIMEOUT_MS: '1000' },
      ),
    ).rejects.toThrow('Empty transcript');
  });

  test('transcribeSource reads the source file and delegates to the transcription endpoint', async () => {
    const fetchImpl = mock(async () => ({
      ok: true,
      json: async () => ({ transcript: 'transcribed text' }),
    })) as any;

    const result = await transcribeSource(
      { mediaPath: '/tmp/current.ogg', mimeType: 'audio/ogg' },
      'en',
      fetchImpl,
      { TRANSCRIBE_ENDPOINT: 'https://stt.example', TRANSCRIBE_TIMEOUT_MS: '1000' },
    );

    expect(result).toBe('transcribed text');
    expect(readFileSpy).toHaveBeenCalledWith('/tmp/current.ogg');
  });
});
