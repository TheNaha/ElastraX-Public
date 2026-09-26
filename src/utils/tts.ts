/**
 * @file src/utils/tts.ts
 * @description Text-to-speech synthesis for voice notes.
 *
 * Two provider shapes are supported:
 *   - `openai`    any OpenAI-compatible `/v1/audio/speech` endpoint. This covers
 *                 OpenAI itself plus most self-hosted servers (Kokoro, Speaches,
 *                 LocalAI, …), so one path serves nearly every setup.
 *   - `elevenlabs` the ElevenLabs REST API.
 *
 * Both are built on BaseHttpClient, so timeouts, redirect policy, protocol
 * validation and response size caps are shared with the rest of the outbound
 * HTTP surface rather than reimplemented.
 *
 * Output is normalised to OGG/Opus, which is what WhatsApp needs for a real
 * voice note (a raw MP3 with `ptt: true` is delivered as a file, not a voice
 * bubble). Callers that do not need Opus can ask for the provider's native
 * container.
 */
import { BaseHttpClient } from './BaseHttpClient';
import { logger } from './logger';
import { readIntegerEnv, readStringEnv } from '../config/runtime';
import { FFmpegConverter } from './FFmpegConverter';

const log = logger.child({ module: 'Tts' });

/** Hard ceiling on synthesised audio, applied to every provider. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** WhatsApp voice notes cap out well below this; refuse earlier with a clear error. */
const DEFAULT_MAX_CHARS = 2_000;

export type TtsProviderName = 'openai' | 'elevenlabs';

export type TtsConfig = {
  provider: TtsProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  maxChars: number;
  timeoutMs: number;
};

export type TtsAudio = {
  buffer: Buffer;
  mimeType: string;
  /** Container extension without the dot, e.g. `ogg`. */
  extension: string;
  /** Rough spoken duration, used only to label the attachment on Discord. */
  durationSeconds: number;
};

/** ~14.5 characters per second is a reasonable average for English narration. */
const CHARS_PER_SECOND = 14.5;

export function estimateDurationSeconds(text: string): number {
  return Math.max(1, Math.round(text.trim().length / CHARS_PER_SECOND));
}

function parseProvider(raw: string | undefined): TtsProviderName {
  return raw?.trim().toLowerCase() === 'elevenlabs' ? 'elevenlabs' : 'openai';
}

export function readTtsConfig(env: NodeJS.ProcessEnv = process.env): TtsConfig {
  const provider = parseProvider(env.TTS_PROVIDER);
  return {
    provider,
    baseUrl: (readStringEnv(env.TTS_BASE_URL)
      || (provider === 'elevenlabs' ? 'https://api.elevenlabs.io' : 'https://api.openai.com')).replace(/\/+$/, ''),
    apiKey: readStringEnv(env.TTS_API_KEY),
    model: readStringEnv(env.TTS_MODEL) || (provider === 'elevenlabs' ? 'eleven_multilingual_v2' : 'tts-1'),
    voice: readStringEnv(env.TTS_VOICE) || (provider === 'elevenlabs' ? '' : 'alloy'),
    maxChars: readIntegerEnv(env.TTS_MAX_CHARS, DEFAULT_MAX_CHARS, { min: 1, max: 20_000 }),
    timeoutMs: readIntegerEnv(env.TTS_TIMEOUT_MS, 60_000, { min: 1_000, max: 300_000 }),
  };
}

export function isTtsConfigured(config: TtsConfig): boolean {
  if (!config.baseUrl || !config.apiKey) return false;
  // ElevenLabs identifies voices by id and has no meaningful default, so an
  // unset voice is a misconfiguration rather than something to guess.
  return config.provider !== 'elevenlabs' || config.voice.length > 0;
}

class TtsClient extends BaseHttpClient {
  constructor(config: TtsConfig) {
    super(
      config.baseUrl,
      config.provider === 'elevenlabs'
        ? { 'xi-api-key': config.apiKey }
        : { Authorization: `Bearer ${config.apiKey}` },
      'TtsClient',
      config.timeoutMs,
      MAX_AUDIO_BYTES,
    );
  }

  async openaiSpeech(text: string, model: string, voice: string, format: string, signal?: AbortSignal): Promise<Buffer> {
    // OpenAI-compatible servers differ on which formats they accept, so opus is
    // not requested here: the container is normalised to opus afterwards.
    this.expectBinary('POST', '/v1/audio/speech', MAX_AUDIO_BYTES);
    return this.post<Buffer>('/v1/audio/speech', {
      model,
      voice,
      input: text,
      response_format: format,
    }, { 'Content-Type': 'application/json', Accept: 'audio/*' }, { signal });
  }

  async elevenlabsSpeech(text: string, voiceId: string, signal?: AbortSignal): Promise<Buffer> {
    const path = `/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
    this.expectBinary('POST', path, MAX_AUDIO_BYTES);
    return this.post<Buffer>(path, { text, model_id: undefined }, { Accept: 'audio/ogg' }, { signal });
  }
}

/** Convert whatever the provider returned into OGG/Opus for a voice note. */
async function toOpus(input: Buffer, inputExtension: string): Promise<Buffer> {
  return FFmpegConverter.convert(input, ['-vn', '-acodec', 'libopus'], inputExtension, 'ogg');
}

export type SynthesizeOptions = {
  text: string;
  voice?: string;
  signal?: AbortSignal;
  config?: TtsConfig;
};

/**
 * Synthesise `text` into OGG/Opus audio suitable for a WhatsApp voice note.
 * Throws when TTS is unconfigured or the provider fails; callers surface the
 * message to the user.
 */
export async function synthesizeSpeech(options: SynthesizeOptions): Promise<TtsAudio> {
  const config = options.config ?? readTtsConfig();
  if (!isTtsConfigured(config)) {
    throw new Error('Text-to-speech is not configured. Set TTS_API_KEY (and TTS_VOICE for ElevenLabs).');
  }
  const text = options.text.trim();
  if (!text) throw new Error('Nothing to speak.');
  if (text.length > config.maxChars) {
    throw new Error(`Text is ${text.length} characters, which exceeds the ${config.maxChars} character limit for a single voice note.`);
  }

  const client = new TtsClient(config);
  const started = Date.now();
  let raw: Buffer;
  let rawExtension: string;
  if (config.provider === 'elevenlabs') {
    raw = await client.elevenlabsSpeech(text, options.voice || config.voice, options.signal);
    rawExtension = 'ogg';
  } else {
    raw = await client.openaiSpeech(text, config.model, options.voice || config.voice, 'mp3', options.signal);
    rawExtension = 'mp3';
  }
  if (raw.byteLength === 0) throw new Error('The speech provider returned an empty audio body.');
  if (raw.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(`Synthesised audio exceeds the ${MAX_AUDIO_BYTES} byte limit.`);
  }

  let buffer = raw;
  let extension = rawExtension;
  if (extension !== 'ogg') {
    try {
      buffer = await toOpus(raw, extension);
      extension = 'ogg';
    } catch (error) {
      // Opus conversion is a nicety: without ffmpeg the provider's own format
      // still delivers audio, just not as a native voice bubble.
      log.warn({ err: error }, 'Opus normalisation failed; sending provider container as-is');
    }
  }

  log.debug({ provider: config.provider, bytes: buffer.byteLength, ms: Date.now() - started }, 'Speech synthesised');
  return {
    buffer,
    mimeType: extension === 'ogg' ? 'audio/ogg; codecs=opus' : `audio/${extension}`,
    extension,
    durationSeconds: estimateDurationSeconds(text),
  };
}
