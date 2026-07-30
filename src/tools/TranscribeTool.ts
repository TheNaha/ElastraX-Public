import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { isTranscriptionConfigured, resolveTranscriptionSource, transcribeSource } from '../utils/transcription';

const log = logger.child({ module: 'TranscribeTool' });

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
    if (!isTranscriptionConfigured()) {
      return t(ctx.language, 'transcribe.not_supported');
    }

    try {
      await ctx.react?.('⏳');
      await ctx.reply(t(ctx.language, 'transcribe.starting'));

      log.debug({ chatId: ctx.chatId, mimeType: ctx.mimeType }, 'Transcription started');

      const source = await resolveTranscriptionSource(ctx, true);
      if (!source) {
        return t(ctx.language, 'convert.no_media');
      }

      const transcript = await transcribeSource(source, ctx.language || 'en');

      log.info({ chatId: ctx.chatId, transcriptLength: transcript.length }, 'Transcription completed');
      return t(ctx.language, 'transcribe.result', { text: transcript });
    } catch (error: unknown) {
      log.error({ err: error, chatId: ctx.chatId }, 'Transcription failed');
      return t(ctx.language, 'transcribe.error', { msg: getErrorMessage(error) });
    }
  }
}
