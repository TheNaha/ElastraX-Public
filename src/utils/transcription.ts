import type { MessageContext } from '../core/MessageContext';
import { getTranscriptionConfig } from '../config/runtime';
import { resolveTargetMedia } from './mediaResolve';
import { detectAudioMimeType, isAudioMagic, readMediaBuffer } from './MediaStorage';
import { NORMAL_MEDIA_MAX_BYTES } from '../providers/media';
import { runBoundedProcess, type BoundedProcessOptions } from '../providers/process';

type TranscriptionResponse = {
  text?: string;
  transcript?: string;
};

export type TranscriptionSource = {
  mediaPath: string;
  mimeType: string;
};

export interface TranscriptionRequestOptions {
  signal?: AbortSignal;
  mode?: 'multipart' | 'json';
  filename?: string;
  probe?: boolean;
}

export const transcriptionDeps = {
  runProcess: undefined as undefined | ((options: BoundedProcessOptions) => Promise<{ stdout: Buffer }>),
};

export function isAudioMimeType(mimeType: string | undefined): boolean {
  return typeof mimeType === 'string' && (mimeType.split(';', 1)[0].trim().toLowerCase().startsWith('audio/'));
}

export function isTranscriptionConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return getTranscriptionConfig(env).endpoint !== '';
}

export async function resolveTranscriptionSource(
  ctx: MessageContext,
  allowQuotedFallback: boolean,
  attachmentId?: string,
): Promise<TranscriptionSource | null> {
  const media = await resolveTargetMedia(ctx, { attachmentId });
  if (!media?.path) return null;
  const isQuoted = !!ctx.quoted?.mediaPath && media.path === ctx.quoted.mediaPath;
  if (isQuoted && !allowQuotedFallback) return null;
  return {
    mediaPath: media.path,
    mimeType: media.mime || ctx.mimeType || (ctx.messageType === 'audioMessage' ? 'application/octet-stream' : 'audio/ogg'),
  };
}

export async function requestTranscription(
  buffer: Buffer,
  mimeType: string,
  language: string,
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
  options: TranscriptionRequestOptions = {},
): Promise<string> {
  const { endpoint, apiKey, timeoutMs } = getTranscriptionConfig(env);
  if (!endpoint) throw new Error('Transcription endpoint is not configured.');
  validateEndpoint(endpoint);
  const validatedMime = await validateAudioBuffer(buffer, mimeType, options);
  const mode = options.mode || (env.TRANSCRIBE_MODE === 'json' ? 'json' : 'multipart');
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  let body: BodyInit;
  if (mode === 'multipart') {
    const form = new FormData();
    const filename = options.filename || audioFilename(validatedMime);
    form.append('file', new Blob([new Uint8Array(buffer)], { type: validatedMime }), filename);
    form.append('language', language || 'en');
    body = form;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({
      audio_base64: buffer.toString('base64'),
      mime_type: validatedMime,
      language,
    });
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    body,
    signal,
  });
  if (!response.ok) throw new Error(`Transcription request failed with HTTP ${response.status}.`);
  const data = await response.json() as TranscriptionResponse;
  const transcript = String(data.text || data.transcript || '').trim();
  if (!transcript) throw new Error('Empty transcript');
  return transcript;
}

export async function transcribeSource(
  source: TranscriptionSource,
  language: string,
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
  options: TranscriptionRequestOptions = {},
): Promise<string> {
  const buffer = await readMediaBuffer(source.mediaPath, NORMAL_MEDIA_MAX_BYTES);
  return requestTranscription(buffer, source.mimeType, language, fetchImpl, env, options);
}

export async function validateAudioBuffer(
  buffer: Buffer,
  declaredMime: string,
  options: Pick<TranscriptionRequestOptions, 'signal' | 'probe'> = {},
): Promise<string> {
  if (buffer.length === 0) throw new Error('Audio input is empty.');
  if (buffer.length > NORMAL_MEDIA_MAX_BYTES) {
    throw new Error(`Audio input exceeds ${NORMAL_MEDIA_MAX_BYTES} bytes.`);
  }
  const declared = normalizeMime(declaredMime);
  const detected = await detectAudioMimeType(buffer);
  if (detected && isStrongAudioMagic(buffer, detected)) return detected;
  if (!detected && isAudioMagic(buffer, declared)) return declared;
  if (detected === 'audio/mp4' || detected === 'audio/aac') return detected;
  if (!isAudioMimeType(declared) && declared !== 'application/octet-stream' && detected === null) {
    throw new Error(`Declared media type is not audio: ${declared || 'unknown'}.`);
  }
  if (options.probe === false) throw new Error('Audio content could not be verified.');
  const probed = await probeAudioBuffer(buffer, options.signal);
  if (!probed) throw new Error('Audio probe found no audio stream.');
  return probed;
}

export async function probeAudioBuffer(buffer: Buffer, signal?: AbortSignal): Promise<string | null> {
  if (buffer.length === 0 || buffer.length > NORMAL_MEDIA_MAX_BYTES) return null;
  const run = transcriptionDeps.runProcess ?? (options => runBoundedProcess(options));
  let result: { stdout: Buffer };
  try {
    result = await run({
      command: 'ffprobe',
      args: ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', 'pipe:0'],
      kind: 'ffprobe',
      timeoutMs: 10_000,
      signal,
      stdoutLimitBytes: 256 * 1024,
      stderrLimitBytes: 64 * 1024,
      input: buffer,
    });
  } catch (error) {
    if (error instanceof Error && /not found|ENOENT/i.test(error.message)) return null;
    throw error;
  }
  let parsed: { streams?: Array<{ codec_type?: string; codec_name?: string }> };
  try {
    parsed = JSON.parse(result.stdout.toString('utf8')) as typeof parsed;
  } catch {
    return null;
  }
  const audio = parsed.streams?.find(stream => stream.codec_type === 'audio');
  return audio ? codecMime(audio.codec_name) : null;
}

function isStrongAudioMagic(buffer: Buffer, mime: string): boolean {
  if (mime === 'audio/mp4' || mime === 'audio/aac') return true;
  return isAudioMagic(buffer, mime);
}

function normalizeMime(mimeType: string | undefined): string {
  return (mimeType || '').split(';', 1)[0].trim().toLowerCase();
}

function validateEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid transcription endpoint URL: ${endpoint}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid protocol for transcription endpoint: ${url.protocol}. Must be http: or https:`);
  }
}

function audioFilename(mimeType: string): string {
  const extensions: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'audio/webm': 'webm',
  };
  return `audio.${extensions[mimeType] || 'bin'}`;
}

function codecMime(codecName: string | undefined): string {
  const normalized = (codecName || '').toLowerCase();
  if (['mp3', 'mp3float'].includes(normalized)) return 'audio/mpeg';
  if (['opus', 'vorbis'].includes(normalized)) return normalized === 'opus' ? 'audio/opus' : 'audio/ogg';
  if (normalized === 'aac') return 'audio/aac';
  if (['flac', 'pcm_alaw', 'pcm_mulaw'].includes(normalized)) return normalized === 'flac' ? 'audio/flac' : 'audio/wav';
  if (['mp4', 'aac_latm'].includes(normalized)) return 'audio/mp4';
  if (normalized === 'vorbis') return 'audio/ogg';
  return 'application/octet-stream';
}
