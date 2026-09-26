/**
 * @file src/utils/StickerUtils.ts
 * @description High-level sticker conversion utilities used by `MakeStickerTool`.
 *
 * Wraps `FFmpegConverter` to produce WhatsApp-compatible WebP sticker buffers from
 * still images and short videos/GIFs.  Also handles writing the EXIF metadata block
 * that WhatsApp requires to recognise a WebP file as a sticker (pack name, author).
 *
 * FFmpeg filter used for both images and videos:
 *  - Scales the input down to at most 320×320 pixels (preserving aspect ratio).
 *  - Pads to exactly 320×320 with a transparent background.
 *  - For videos: caps at 15 fps and truncates to the first 5 seconds (WA sticker limit).
 *  - Converts to a palette-based WebP with transparency support.
 *
 * Prerequisites: `ffmpeg` binary must be available on the system PATH.
 */

import { FFmpegConverter, STICKER_WEBP_FILTER } from './FFmpegConverter';
import { APP_VERSION } from '../config/version';
import nodeWebpmux from 'node-webpmux';

/** Utilities for converting images/videos to WhatsApp sticker WebP format. */
export class StickerUtils {
  // Single source of truth: FFmpegConverter owns the allowlist that has to
  // accept this filter, so the validated value and the executed value cannot drift.
  private static readonly WEBP_FILTER = STICKER_WEBP_FILTER;

  /**
   * Translates a static image to WEBP formatted properly for WhatsApp Stickers.
   */
  static async imageToWebp(media: Buffer): Promise<Buffer> {
    return FFmpegConverter.convert(media, [
      '-vcodec', 'libwebp',
      '-vf', 
      this.WEBP_FILTER
    ], 'img', 'webp');
  }

  /**
   * Translates an MP4 video or GIF to an animated WEBP properly formatted for WhatsApp Stickers.
   */
  static async videoToWebp(media: Buffer): Promise<Buffer> {
    return FFmpegConverter.convert(media, [
      '-vcodec', 'libwebp',
      '-vf', 
      this.WEBP_FILTER,
      '-loop', '0',
      '-ss', '00:00:00',
      '-t', '00:00:05',
      '-preset', 'default',
      '-an',
      '-fps_mode', 'passthrough'
    ], 'mp4', 'webp');
  }

  /**
   * Writes WhatsApp sticker pack name and author EXIF into a WEBP.
   */
  static async writeExif(media: Buffer, metadata: { packname?: string, author?: string, categories?: string[] }): Promise<Buffer> {
    const img = new nodeWebpmux.Image();
    await img.load(media);

    const packname = metadata.packname || `ElastraX-v${APP_VERSION}`;
    const author = metadata.author || 'AI Agent';
    const categories = metadata.categories || [''];

    const json = { 
      'sticker-pack-id': 'ElastraX', 
      'sticker-pack-name': packname, 
      'sticker-pack-publisher': author, 
      'emojis': categories 
    };
    
    // Magic EXIF headers required to be recognized by WA natively
    const exifAttr = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
    const jsonBuff = Buffer.from(JSON.stringify(json), 'utf-8');
    const exif = Buffer.concat([exifAttr, jsonBuff]);
    exif.writeUIntLE(jsonBuff.length, 14, 4);
    
    img.exif = exif;

    return await img.save(null) as Buffer;
  }
}
