/**
 * @file src/utils/transcription.ts
 * @description Shared transcription helpers for automatic and explicit STT flows.
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import type { MessageContext } from '../core/MessageContext';
import { getTranscriptionConfig } from '../config/runtime';

type TranscriptionResponse = {
  text?: string;
  transcript?: string;
};

export type TranscriptionSource = {
  mediaPath: string;
  mimeType: string;
};

export function isAudioMimeType(mimeType: string | undefined): boolean {
  return typeof mimeType === 'string' && mimeType.startsWith('audio/');
}

export function isTranscriptionConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return getTranscriptionConfig(env).endpoint !== '';
}

export async function resolveTranscriptionSource(
  ctx: MessageContext,
  allowQuotedFallback: boolean,
): Promise<TranscriptionSource | null> {
  await ctx.mediaReady;

  if (ctx.mediaPath && existsSync(ctx.mediaPath)) {
    return {
      mediaPath: ctx.mediaPath,
      mimeType: ctx.mimeType || 'audio/ogg',
    };
  }

  if (allowQuotedFallback && ctx.quoted?.mediaPath && existsSync(ctx.quoted.mediaPath)) {
    return {
      mediaPath: ctx.quoted.mediaPath,
      mimeType: ctx.quoted.mimeType || ctx.mimeType || 'audio/ogg',
    };
  }

  return null;
}

export async function requestTranscription(
  buffer: Buffer,
  mimeType: string,
  language: string,
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const { endpoint, apiKey, timeoutMs } = getTranscriptionConfig(env);
  if (!endpoint) {
    throw new Error('Transcription endpoint is not configured.');
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid transcription endpoint URL: ${endpoint}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid protocol for transcription endpoint: ${url.protocol}. Must be http: or https:`);
  }

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey ? `Bearer ${apiKey}` : '',
    },
    body: JSON.stringify({
      audio_base64: buffer.toString('base64'),
      mime_type: mimeType,
      language,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json() as TranscriptionResponse;
  const transcript = String(data.text || data.transcript || '').trim();
  if (!transcript) {
    throw new Error('Empty transcript');
  }

  return transcript;
}

export async function transcribeSource(
  source: TranscriptionSource,
  language: string,
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const buffer = await readFile(source.mediaPath);
  return requestTranscription(buffer, source.mimeType, language, fetchImpl, env);
}
