/**
 * @file src/utils/ocr.ts
 * @description Vision-based text extraction for the room knowledge base.
 *
 * The bot can already *see* images — the agent builds an `image_url` content
 * block for attachments — but the knowledge base refused to index them. This
 * closes that gap: the image is sent to a vision-capable model with an
 * instruction to transcribe it faithfully, and the result is chunked and
 * embedded exactly like a text document.
 *
 * It is transcription, not description. The prompt is explicit that the output
 * becomes searchable room state, so a model that starts summarising or
 * embellishing produces a worse knowledge base than one that transcribes.
 */
import { getModelRouter } from './ModelRouter';
import { readIntegerEnv } from '../config/runtime';
import { logger } from './logger';
import { INLINE_MEDIA_MAX_BYTES } from '../providers/media';
import type { AIChatMessage } from '../ai/client';
import type { ModelTier } from '../types/ai';

const log = logger.child({ module: 'Ocr' });

/** Above this, transcription cost and latency are not worth it. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** Transcription of a dense page can run long; cap it so one page cannot hang. */
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

const INSTRUCTION = [
  'Transcribe all readable text from this image verbatim.',
  '',
  'Rules:',
  '- Output only the transcribed text. No preamble, no commentary, no summary.',
  '- Preserve reading order, line breaks, headings, table structure and lists.',
  '- Keep numbers, dates, codes, URLs, currency amounts and units exactly as written.',
  '- If a region is illegible, write [illegible] in its place rather than guessing.',
  '- If the image contains no readable text at all, reply with exactly: NO_TEXT',
].join('\n');

export type OcrConfig = {
  enabled: boolean;
  maxBytes: number;
  maxOutputTokens: number;
  tier: ModelTier;
};

export function readOcrConfig(env: NodeJS.ProcessEnv = process.env): OcrConfig {
  const tier = (readIntegerEnv(env.KB_OCR_TIER, 0, { min: 0, max: 2 }) === 0 ? 'standard' : 'fast') as ModelTier;
  return {
    // On by default: indexing a document is already an explicit request to spend
    // tokens, and refusing images outright left the feature half-built.
    enabled: !/^(0|false|no|off)$/i.test((env.KB_OCR_ENABLED ?? '').trim()),
    maxBytes: readIntegerEnv(env.KB_OCR_MAX_BYTES, DEFAULT_MAX_BYTES, { min: 4_096, max: INLINE_MEDIA_MAX_BYTES }),
    maxOutputTokens: readIntegerEnv(env.KB_OCR_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, { min: 128, max: 16_000 }),
    tier,
  };
}

/** Strip the fences and hedging a chat model tends to wrap transcription in. */
export function cleanTranscription(raw: string): string {
  let text = raw.trim();
  if (text.length === 0) return '';
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence?.[1]) text = fence[1].trim();
  text = text.replace(/^(?:here(?:'s| is)[^\n:]*:|transcription:|extracted text:)\s*/i, '').trim();
  if (/^no[_ ]?text\.?$/i.test(text)) return '';
  return text;
}

export type OcrResult = {
  text: string;
  /** True when the model reported no readable text, or returned nothing usable. */
  empty: boolean;
};

/**
 * Transcribe an image with a vision-capable model. Throws with a
 * user-presentable reason when the input is too large or the model call fails.
 */
export async function transcribeImage(
  buffer: Buffer,
  mimeType: string,
  options: { config?: OcrConfig; signal?: AbortSignal } = {},
): Promise<OcrResult> {
  const config = options.config ?? readOcrConfig();
  if (!config.enabled) throw new Error('OCR is disabled.');
  if (buffer.byteLength === 0) throw new Error('The image was empty.');
  if (buffer.byteLength > config.maxBytes) {
    const mb = Math.round(config.maxBytes / (1024 * 1024));
    throw new Error(`Image is larger than the ${mb} MB OCR limit.`);
  }

  const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;
  const messages: AIChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: INSTRUCTION },
        { type: 'image_url', image_url: { url: dataUri } },
      ],
    },
  ];

  const router = getModelRouter();
  const response = await router.chatCompletion(
    messages,
    undefined,
    0,
    config.maxOutputTokens,
    config.tier,
  );
  const text = cleanTranscription(typeof response === 'string' ? response : String(response.content ?? ''));
  log.debug({ bytes: buffer.byteLength, mimeType, chars: text.length }, 'OCR transcription complete');
  return { text, empty: text.length === 0 };
}

/** Whether a mime type is something we can reasonably send for transcription. */
export function isTranscribableMime(mimeType: string): boolean {
  const mime = mimeType.toLowerCase().split(';')[0].trim();
  return mime.startsWith('image/') || mime === 'application/pdf';
}
