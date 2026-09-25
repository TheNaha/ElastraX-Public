import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { isTranscriptionConfigured, resolveTranscriptionSource, transcribeSource } from '../utils/transcription';

type TranscribeArgs = ToolArgs & { attachment_id?: string };

const log = logger.child({ module: 'TranscribeTool' });

export class TranscribeTool extends BaseTool<TranscribeArgs> {
  readonly name = 'transcribe_audio';
  readonly description = 'Transcribe an attached or quoted audio/voice note to text.';
  readonly aliases = ['transcribe', 'stt'];
  readonly category = 'utility';
  readonly permissions = 'user';
  override readonly triggerPatterns = [/^audio\//i, /\b(transcribe|transkrip|what did they say|apa yang dia bilang)\b/i];

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            attachment_id: {
              type: 'string',
              description: 'Optional attachment identifier for multi-attachment messages',
            },
          },
          required: [],
        },
      },
    };
  }

  async execute(args: TranscribeArgs, ctx: MessageContext, signal?: AbortSignal): Promise<string> {
    if (!isTranscriptionConfigured()) {
      return t(ctx.language, 'transcribe.not_supported');
    }

    try {
      await ctx.react?.('⏳');
      await ctx.reply(t(ctx.language, 'transcribe.starting'));

      log.debug({ chatId: ctx.chatId, mimeType: ctx.mimeType }, 'Transcription started');

      const source = await resolveTranscriptionSource(
        ctx,
        true,
        typeof args.attachment_id === 'string' ? args.attachment_id : undefined,
      );
      if (!source) {
        return t(ctx.language, 'convert.no_media');
      }

      const transcript = await transcribeSource(source, ctx.language || 'en', fetch, process.env, {
        signal: signal ?? ctx.signal,
      });

      log.info({ chatId: ctx.chatId, transcriptLength: transcript.length }, 'Transcription completed');
      return t(ctx.language, 'transcribe.result', { text: transcript });
    } catch (error: unknown) {
      log.error({ err: error, chatId: ctx.chatId }, 'Transcription failed');
      return t(ctx.language, 'transcribe.error', { msg: getErrorMessage(error) });
    }
  }
}
