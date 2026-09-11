/**
 * @file src/tools/MediaConvertTool.ts
 * @description Media format converter powered by FFmpeg.
 *
 * Converts an attached or quoted media file from one format to another using
 * the FFmpegConverter utility. Users can attach a file and request conversion,
 * or reply to a previously shared file.
 *
 * Supported conversions (non-exhaustive):
 *   Audio: mp3 ↔ ogg ↔ aac ↔ m4a ↔ opus ↔ wav
 *   Video: mp4 ↔ mkv ↔ webm ↔ gif
 *   Image: jpg ↔ png ↔ webp
 *   Cross:  video → audio (extract audio track)
 *
 * Works conversationally ("convert this to mp3") and via slash command:
 *   /convert [target_format]   — attach or reply to a media file
 *
 * Slash command aliases: /convert, /cv
 */

import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { FFmpegConverter } from '../utils/FFmpegConverter';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { resolveTargetMedia, loadMediaBytes } from '../utils/mediaResolve';
import { EXT_MIME, extensionFor } from '../utils/mimeTypes';

const log = logger.child({ module: 'MediaConvertTool' });

type ConvertFormat = 'mp3' | 'mp4' | 'ogg' | 'aac' | 'opus' | 'm4a' | 'wav' | 'webm' | 'mkv' | 'gif' | 'png' | 'jpg' | 'webp';
type MediaConvertArgs = ToolArgs & {
  format?: string;
};

const FORMAT_ARGS: Record<ConvertFormat, string[]> = {
  mp3: ['-vn', '-acodec', 'libmp3lame', '-q:a', '2'],
  ogg: ['-vn', '-acodec', 'libvorbis'],
  aac: ['-vn', '-acodec', 'aac'],
  opus: ['-vn', '-acodec', 'libopus'],
  m4a: ['-vn', '-acodec', 'aac'],
  wav: ['-vn', '-acodec', 'pcm_s16le'],
  mp4: ['-vcodec', 'libx264', '-acodec', 'aac', '-movflags', 'faststart'],
  webm: ['-vcodec', 'libvpx-vp9', '-acodec', 'libopus'],
  mkv: ['-vcodec', 'copy', '-acodec', 'copy'],
  gif: ['-vf', 'fps=10,scale=320:-1:flags=lanczos', '-loop', '0'],
  png: ['-vframes', '1'],
  jpg: ['-vframes', '1'],
  webp: ['-vcodec', 'libwebp', '-lossless', '0', '-quality', '80'],
};

const FORMAT_MIME: Record<ConvertFormat, string> = Object.fromEntries(
  (Object.keys(FORMAT_ARGS) as ConvertFormat[]).map((fmt) => [fmt, EXT_MIME[fmt]]),
) as Record<ConvertFormat, string>;

export class MediaConvertTool extends BaseTool<MediaConvertArgs> {
  readonly name = 'convert_media';
  readonly description = 'Convert attached/quoted media to a different format (audio, video, image).';
  readonly aliases = ['convert', 'cv'];
  readonly category = 'media';
  readonly permissions = 'user';
  override readonly triggerPatterns = [/^image\//i, /^video\//i, /^audio\//i, /\b(convert|konversi|ubah|change format)\b/i];

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              enum: Object.keys(FORMAT_ARGS),
              description: 'Target output format to convert to.',
            },
          },
          required: ['format'],
        },
      },
    };
  }

  async execute(args: MediaConvertArgs, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    const targetFmt = (args.format || '').toLowerCase() as ConvertFormat;

    // Security: Validate the requested format safely to prevent prototype pollution
    if (!Object.prototype.hasOwnProperty.call(FORMAT_ARGS, targetFmt)) {
      return t(lang, 'convert.unsupported', { from: 'source', to: targetFmt });
    }

    if (!ctx.sendMedia) return t(lang, 'convert.not_supported');

    // Resolve media: current message > quoted message > on-demand download
    const media = await resolveTargetMedia(ctx, {
      useDownloader: Boolean(ctx.downloadMedia),
      beforeDownload: () => ctx.react?.('📥'),
    });
    if (!media) return t(lang, 'convert.no_media');

    try {
      await ctx.react?.('⚙️');
      await ctx.reply(t(lang, 'convert.starting'));

      const inputBuffer = await loadMediaBytes(media);
      const extIn = extensionFor(media.mime || 'video/mp4');
      const ffmpegArgs = FORMAT_ARGS[targetFmt];

      log.info({ from: extIn, to: targetFmt, inputSize: inputBuffer.length, chatId: ctx.chatId }, 'Media conversion started');

      const outputBuffer = await FFmpegConverter.convert(inputBuffer, ffmpegArgs, extIn, targetFmt);

      log.debug({ from: extIn, to: targetFmt, outputSize: outputBuffer.length }, 'Media conversion completed');

      await ctx.sendMedia(outputBuffer, {
        mimetype: FORMAT_MIME[targetFmt],
        filename: `converted.${targetFmt}`,
      });

      return t(lang, 'convert.success');
    } catch (error: unknown) {
      log.error({ err: error, targetFmt, chatId: ctx.chatId }, 'Media conversion failed');
      return t(lang, 'convert.error', { msg: getErrorMessage(error).slice(0, 200) });
    }
  }
}
