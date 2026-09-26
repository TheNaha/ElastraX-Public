import { BaseTool, type ToolArgs, type ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { isTtsConfigured, readTtsConfig, synthesizeSpeech } from '../utils/tts';

const log = logger.child({ module: 'SpeakTool' });

type SpeakArgs = ToolArgs & {
  text?: string;
  voice?: string;
};

export class SpeakTool extends BaseTool<SpeakArgs> {
  readonly name = 'speak';
  readonly description = 'Send a message as a voice note (text-to-speech audio). Use when the user asks to be spoken to, or asks for an audio/voice reply.';
  readonly aliases = ['tts', 'say', 'voice'];
  readonly category = 'media';
  readonly permissions = 'user';
  override readonly triggerPatterns = [/\b(speak|say it|voice note|voice message|tts|bacakan|ucapkan)\b/i];
  override readonly mutability = 'external-mutation' as const;
  override readonly cost = 2;

  /**
   * Always registered, even when no provider is configured.
   *
   * A registry-dropped tool makes `/speak` report "command not found", which is
   * indistinguishable from a typo and reads as a broken feature. Reporting
   * "voice replies are not configured, ask the owner to set TTS_API_KEY" is
   * actionable instead. The tool is not `alwaysLoad`, so it is only advertised
   * to the model when progressive disclosure reaches it.
   */
  isEnabled(): boolean {
    return true;
  }

  /** Whether synthesis can actually run, used for the user-facing message. */
  isConfigured(): boolean {
    return isTtsConfigured(readTtsConfig());
  }

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'The text to speak. Keep it reasonably short; very long text is rejected.',
              maxLength: 2000,
            },
            voice: {
              type: 'string',
              description: 'Optional voice identifier. Provider-specific (e.g. "alloy" for OpenAI-compatible, a voice id for ElevenLabs).',
            },
          },
          required: ['text'],
        },
      },
    };
  }

  async execute(args: SpeakArgs, ctx: MessageContext): Promise<string> {
    const config = readTtsConfig();
    if (!isTtsConfigured(config)) {
      return t(ctx.language, 'speak.not_configured');
    }

    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) return t(ctx.language, 'speak.empty');

    try {
      const audio = await synthesizeSpeech({
        text,
        ...(typeof args.voice === 'string' && args.voice ? { voice: args.voice } : {}),
        signal: ctx.signal,
        config,
      });

      await ctx.react?.('🔊').catch(() => {});
      await ctx.sendMedia(audio.buffer, {
        mimetype: audio.mimeType,
        filename: `voice-${Date.now()}.${audio.extension}`,
        ptt: true,
        durationSeconds: audio.durationSeconds,
      });
      log.debug({ chatId: ctx.chatId, bytes: audio.buffer.byteLength }, 'Voice note sent');
      return '';
    } catch (error: unknown) {
      log.error({ err: error, chatId: ctx.chatId }, 'Speech synthesis failed');
      return t(ctx.language, 'speak.error', { msg: getErrorMessage(error) });
    }
  }
}
