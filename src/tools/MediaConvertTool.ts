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

import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { FFmpegConverter } from '../utils/FFmpegConverter';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

type ConvertFormat = 'mp3' | 'mp4' | 'ogg' | 'aac' | 'opus' | 'm4a' | 'wav' | 'webm' | 'mkv' | 'gif' | 'png' | 'jpg' | 'webp';

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

const MIME_MAP: Record<ConvertFormat, string> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  opus: 'audio/opus',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

function getExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/aac': 'aac',
    'audio/opus': 'opus',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'video/quicktime': 'mov',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
  };
  return map[mimeType] || mimeType.split('/')[1] || 'bin';
}

export class MediaConvertTool extends BaseTool {
  readonly name = 'convert_media';
  readonly description = 'Convert an attached or quoted media file to a different format using FFmpeg. The user must attach or reply to a media file. Supported formats: mp3, mp4, ogg, aac, opus, m4a, wav, webm, mkv, gif, png, jpg, webp.';
  readonly aliases = ['convert', 'cv'];
  readonly category = 'media';
  readonly permissions = 'user';

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

  async execute(args: Record<string, any>, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    const targetFmt = (args.format || '').toLowerCase() as ConvertFormat;

    if (!FORMAT_ARGS[targetFmt]) {
      return t(lang, 'convert.unsupported', { from: 'source', to: targetFmt });
    }

    if (!ctx.sendMedia) return t(lang, 'convert.not_supported');

    // Resolve media: current message > quoted message
    let mediaPath = ctx.mediaPath;
    let mimeType = ctx.mimeType;

    if (!mediaPath && ctx.quoted?.mediaPath) {
      mediaPath = ctx.quoted.mediaPath;
      mimeType = ctx.quoted.mimeType;
    }

    if (!mediaPath) {
      // Try downloading on-demand
      if (!ctx.downloadMedia) return t(lang, 'convert.no_media');
      await ctx.react?.('📥');
      await ctx.mediaReady;
      mediaPath = ctx.mediaPath;
      mimeType = ctx.mimeType;
    }

    if (!mediaPath || !existsSync(mediaPath)) {
      return t(lang, 'convert.no_media');
    }

    try {
      await ctx.react?.('⚙️');
      await ctx.reply(t(lang, 'convert.starting'));

      const inputBuffer = await readFile(mediaPath);
      const extIn = getExtension(mimeType || 'video/mp4');
      const ffmpegArgs = FORMAT_ARGS[targetFmt];

      const outputBuffer = await FFmpegConverter.convert(inputBuffer, ffmpegArgs, extIn, targetFmt);

      await ctx.sendMedia(outputBuffer, {
        mimetype: MIME_MAP[targetFmt],
        filename: `converted.${targetFmt}`,
      });

      return t(lang, 'convert.success');
    } catch (err: any) {
      logger.error({ err }, '[MediaConvertTool] Conversion failed');
      return t(lang, 'convert.error', { msg: err.message.slice(0, 200) });
    }
  }
}
