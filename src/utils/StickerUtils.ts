import { FFmpegConverter } from './FFmpegConverter';
import nodeWebpmux from 'node-webpmux';

export class StickerUtils {
  /**
   * Translates a static image to WEBP formatted properly for WhatsApp Stickers.
   */
  static async imageToWebp(media: Buffer): Promise<Buffer> {
    return FFmpegConverter.convert(media, [
      '-vcodec', 'libwebp',
      '-vf', 
      "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse"
    ], 'img', 'webp');
  }

  /**
   * Translates an MP4 video or GIF to an animated WEBP properly formatted for WhatsApp Stickers.
   */
  static async videoToWebp(media: Buffer): Promise<Buffer> {
    return FFmpegConverter.convert(media, [
      '-vcodec', 'libwebp',
      '-vf', 
      "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse",
      '-loop', '0',
      '-ss', '00:00:00',
      '-t', '00:00:05',
      '-preset', 'default',
      '-an',
      '-vsync', '0'
    ], 'mp4', 'webp');
  }

  /**
   * Writes WhatsApp sticker pack name and author EXIF into a WEBP.
   */
  static async writeExif(media: Buffer, metadata: { packname?: string, author?: string, categories?: string[] }): Promise<Buffer> {
    const img = new nodeWebpmux.Image();
    await img.load(media);

    const packname = metadata.packname || 'ElastraGPBOT-v7';
    const author = metadata.author || 'AI Agent';
    const categories = metadata.categories || [''];

    const json = { 
      'sticker-pack-id': 'ElastraGPBOT', 
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
