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
   * Registered only once a provider is configured.
   *
   * The registry filters on `isEnabled()` at load time, so an unconfigured bot
   * never lists this tool: it is absent from `/menu`, from the model's tool
   * list, and `/speak` reports an unknown command rather than offering a voice
   * reply it cannot deliver. This matches how the other opt-in tools (game and
   * software search, the media library, the piracy tools) already behave.
   *
   * Setting TTS_API_KEY and reloading the registry surfaces it.
   */
  isEnabled(): boolean {
    return isTtsConfigured(readTtsConfig());
  }

  /** Whether synthesis can actually run. */
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
    // Defence in depth. The registry already withholds this tool when
    // unconfigured, but config is read per call, so a key removed after load
    // (or an instance captured before a reload) must still fail cleanly rather
    // than issuing a request with no credentials.
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
