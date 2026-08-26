/**
 * @file src/utils/mimeTypes.ts
 * @description Single canonical extension↔MIME mapping shared by all tools.
 */

export const EXT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  opus: 'audio/opus',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

const MIME_EXT: Record<string, string> = Object.create(null);
for (const [ext, mime] of Object.entries(EXT_MIME)) {
  if (!(mime in MIME_EXT)) MIME_EXT[mime] = ext;
}

export function mimeToExt(mime: string): string {
  return MIME_EXT[mime] || mime.split('/')[1] || 'bin';
}

export const extensionFor = mimeToExt;
