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
  attachment_id?: string;
  /** Scale video to a target resolution (e.g. "720p", "1080p", or "640x480"). */
  resolution?: string;
  /** Set the output frame rate (e.g. "30", "24"). */
  fps?: string;
  /** Quality: CRF for video (lower=better, e.g. "23"), or bitrate for audio (e.g. "128k"). */
  quality?: string;
  /** Encoding preset: ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow. */
  preset?: string;
};

const VALID_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];

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

/**
 * Build additional ffmpeg arguments from optional quality parameters.
 * Merges filter chains with any existing `-vf` arguments.
 */
function buildConvertArgs(
  fmt: ConvertFormat,
  resolution: string | undefined,
  fps: string | undefined,
  quality: string | undefined,
  preset: string | undefined,
): string[] {
  const extraArgs: string[] = [];
  const filters: string[] = [];

  if (resolution) {
    const match = resolution.match(/^(\d+)x(\d+)$/);
    if (match) {
      filters.push(`scale=${match[1]}:${match[2]}`);
    } else {
      const heightMatch = resolution.match(/^(\d+)p$/);
      if (heightMatch) {
        // -2 keeps the aspect ratio, width auto-scaled
        filters.push(`scale=-2:${heightMatch[1]}`);
      }
    }
  }

  if (fps) {
    filters.push(`fps=${fps}`);
  }

  if (filters.length > 0) {
    extraArgs.push('-vf', filters.join(','));
  }

  if (quality) {
    const isVideo = ['mp4', 'mkv', 'webm', 'gif'].includes(fmt);
    if (isVideo) {
      // CRF mode: lower = better quality
      const crf = Number.parseInt(quality, 10);
      if (!Number.isNaN(crf) && crf >= 0 && crf <= 63) {
        extraArgs.push('-crf', String(crf));
      }
    } else {
      // Audio bitrate (e.g. "128k", "64k")
      if (/^\d+[kKmM]?$/.test(quality)) {
        extraArgs.push('-b:a', quality);
      }
    }
  }

  if (preset && ['mp4', 'mkv', 'webm'].includes(fmt)) {
    extraArgs.push('-preset', preset);
  }

  return extraArgs;
}

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
            attachment_id: {
              type: 'string',
              description: 'Optional attachment identifier when the message contains multiple attachments.',
            },
            resolution: {
              type: 'string',
              pattern: '^(\\d+x\\d+|\\d+p)$',
              description: 'Scale to a target resolution (e.g. "720p", "1080p", "640x480").',
            },
            fps: {
              type: 'string',
              pattern: '^\\d+$',
              description: 'Set the output frame rate (e.g. "30", "24").',
            },
            quality: {
              type: 'string',
              description: 'Quality: CRF for video (e.g. "23"), or bitrate for audio (e.g. "128k").',
            },
            preset: {
              type: 'string',
              enum: VALID_PRESETS,
              description: 'Encoding speed preset. Slower = better compression. Only for video codecs that support it.',
            },
          },
          required: ['format'],
        },
      },
    };
  }

  async execute(args: MediaConvertArgs, ctx: MessageContext, signal?: AbortSignal): Promise<string> {
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
      attachmentId: typeof args.attachment_id === 'string' ? args.attachment_id : undefined,
    });
    if (!media) return t(lang, 'convert.no_media');

    try {
      await ctx.react?.('⚙️');
      await ctx.reply(t(lang, 'convert.starting'));

      const inputBuffer = await loadMediaBytes(media);
      const extIn = extensionFor(media.mime || 'video/mp4');
      const baseArgs = FORMAT_ARGS[targetFmt];
      const extraArgs = buildConvertArgs(targetFmt, args.resolution, args.fps, args.quality, args.preset);
      const ffmpegArgs = [...baseArgs, ...extraArgs];

      log.info({ from: extIn, to: targetFmt, resolution: args.resolution, fps: args.fps, quality: args.quality, preset: args.preset, inputSize: inputBuffer.length, chatId: ctx.chatId }, 'Media conversion started');

      const outputBuffer = await FFmpegConverter.convert(inputBuffer, ffmpegArgs, extIn, targetFmt, {
        signal: signal ?? ctx.signal,
      });

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
