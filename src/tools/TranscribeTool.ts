import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

const log = logger.child({ module: 'TranscribeTool' });

type TranscribeResponse = {
  text?: string;
  transcript?: string;
};

export class TranscribeTool extends BaseTool<ToolArgs> {
  readonly name = 'transcribe_audio';
  readonly description = 'Transcribe an attached or quoted audio/voice note to text.';
  readonly aliases = ['transcribe', 'stt'];
  readonly category = 'utility';
  readonly permissions = 'user';
  override readonly triggerPatterns = [/^audio\//i];

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    };
  }

  async execute(_args: ToolArgs, ctx: MessageContext): Promise<string> {
    const endpoint = process.env.TRANSCRIBE_ENDPOINT;
    if (!endpoint) {
      return t(ctx.language, 'transcribe.not_supported');
    }

    try {
      await ctx.react?.('??');
      await ctx.reply(t(ctx.language, 'transcribe.starting'));

      log.debug({ chatId: ctx.chatId, mimeType: ctx.mimeType }, 'Transcription started');

      await ctx.mediaReady;
      let mediaPath = ctx.mediaPath;
      let mimeType = ctx.mimeType || 'audio/ogg';

      if ((!mediaPath || !existsSync(mediaPath)) && ctx.quoted?.mediaPath) {
        mediaPath = ctx.quoted.mediaPath;
        mimeType = ctx.quoted.mimeType || mimeType;
      }

      if (!mediaPath || !existsSync(mediaPath)) {
        return t(ctx.language, 'convert.no_media');
      }

      const buffer = await readFile(mediaPath);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: process.env.TRANSCRIBE_API_KEY ? `Bearer ${process.env.TRANSCRIBE_API_KEY}` : '',
        },
        body: JSON.stringify({
          audio_base64: buffer.toString('base64'),
          mime_type: mimeType,
          language: ctx.language || 'en',
        }),
        signal: AbortSignal.timeout(parseInt(process.env.TRANSCRIBE_TIMEOUT_MS || '45000', 10)),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as TranscribeResponse;
      const transcript = String(data.text || data.transcript || '').trim();
      if (!transcript) {
        throw new Error('Empty transcript');
      }

      log.info({ chatId: ctx.chatId, transcriptLength: transcript.length }, 'Transcription completed');
      return t(ctx.language, 'transcribe.result', { text: transcript });
    } catch (error: unknown) {
      log.error({ err: error, chatId: ctx.chatId }, 'Transcription failed');
      return t(ctx.language, 'transcribe.error', { msg: getErrorMessage(error) });
    }
  }
}
