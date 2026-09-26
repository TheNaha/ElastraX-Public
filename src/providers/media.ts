import { open, stat } from 'node:fs/promises';
import { CancellableSemaphore } from './semaphore';

export const MIB = 1024 * 1024;
export const NORMAL_MEDIA_MAX_BYTES = 32 * MIB;
export const HARD_MEDIA_MAX_BYTES = 200 * MIB;
export const INLINE_MEDIA_MAX_BYTES = 10 * MIB;
export const INLINE_MEDIA_MAX_PIXELS = 20_000_000;
export const MAX_INLINE_DIMENSION = 20_000;

export const globalMediaDownloadSlots = new CancellableSemaphore(4);
export const globalMediaByteBudget = new CancellableSemaphore(HARD_MEDIA_MAX_BYTES);
export const globalMediaIoSlots = new CancellableSemaphore(1);

export class MediaLimitError extends Error {
  readonly code = 'MEDIA_LIMIT_EXCEEDED';

  constructor(
    readonly actualBytes: number,
    readonly maxBytes: number,
  ) {
    super(`Media exceeds the ${maxBytes}-byte limit (received at least ${actualBytes} bytes).`);
    this.name = 'MediaLimitError';
  }
}

export type InlineIneligibleReason =
  | 'not-image'
  | 'too-large'
  | 'dimensions-unavailable'
  | 'dimensions-too-large'
  | 'invalid-dimensions';

export interface InlineMediaMetadata {
  sizeBytes: number;
  mimeType?: string;
  width?: number;
  height?: number;
}

export type InlineMediaEligibility =
  | { eligible: true; sizeBytes: number; mimeType: string; width: number; height: number; pixels: number }
  | { eligible: false; sizeBytes: number; mimeType: string; reason: InlineIneligibleReason; pixels?: number };

export function evaluateInlineMediaMetadata(metadata: InlineMediaMetadata): InlineMediaEligibility {
  const mimeType = normalizeMime(metadata.mimeType);
  const base = { sizeBytes: metadata.sizeBytes, mimeType };
  if (!mimeType.startsWith('image/')) return { ...base, eligible: false, reason: 'not-image' };
  if (!Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 0) {
    return { ...base, eligible: false, reason: 'invalid-dimensions' };
  }
  if (metadata.sizeBytes > INLINE_MEDIA_MAX_BYTES) return { ...base, eligible: false, reason: 'too-large' };

  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) return { ...base, eligible: false, reason: 'dimensions-unavailable' };
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > MAX_INLINE_DIMENSION || height > MAX_INLINE_DIMENSION) {
    return { ...base, eligible: false, reason: 'invalid-dimensions' };
  }
  const pixels = width * height;
  if (pixels > INLINE_MEDIA_MAX_PIXELS) {
    return { ...base, eligible: false, reason: 'dimensions-too-large', pixels };
  }
  return { eligible: true, sizeBytes: metadata.sizeBytes, mimeType, width, height, pixels };
}

export async function getInlineMediaEligibility(
  mediaPath: string,
  mimeType?: string,
  dimensions?: { width: number; height: number },
): Promise<InlineMediaEligibility> {
  const info = await stat(mediaPath);
  if (!info.isFile()) {
    return evaluateInlineMediaMetadata({ sizeBytes: info.size, mimeType, width: 0, height: 0 });
  }
  const width = dimensions?.width;
  const height = dimensions?.height;
  if (width && height) {
    return evaluateInlineMediaMetadata({ sizeBytes: info.size, mimeType, width, height });
  }
  if (info.size > INLINE_MEDIA_MAX_BYTES) {
    return evaluateInlineMediaMetadata({ sizeBytes: info.size, mimeType, width: 0, height: 0 });
  }
  const prefix = await readPrefix(mediaPath, Math.min(info.size, MIB));
  const detected = getImageDimensions(prefix);
  return evaluateInlineMediaMetadata({
    sizeBytes: info.size,
    mimeType,
    width: detected?.width,
    height: detected?.height,
  });
}

export function createLazyPromise<T>(operation: () => Promise<T>): Promise<T> {
  let started: Promise<T> | undefined;
  const start = (): Promise<T> => {
    if (!started) started = Promise.resolve().then(operation);
    return started;
  };
  const base = new Promise<T>(() => undefined) as Promise<T>;
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'then') return (onfulfilled?: ((value: T) => unknown) | null, onrejected?: ((reason: unknown) => unknown) | null) => start().then(onfulfilled, onrejected);
      if (property === 'catch') return (onrejected?: ((reason: unknown) => unknown) | null) => start().catch(onrejected);
      if (property === 'finally') return (onfinally?: (() => void) | null) => start().finally(onfinally);
      return Reflect.get(target, property, receiver);
    },
  });
}

async function readPrefix(path: string, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function normalizeMime(mimeType?: string): string {
  return (mimeType || '').split(';', 1)[0].trim().toLowerCase();
}

function getImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && (buffer.toString('ascii', 0, 3) === 'GIF')) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return getJpegDimensions(buffer);
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return getWebpDimensions(buffer);
  }
  return null;
}

function getJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === undefined || marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if (marker >= 0xc0 && marker <= 0xc3 || marker >= 0xc5 && marker <= 0xc7 || marker >= 0xc9 && marker <= 0xcb || marker >= 0xcd && marker <= 0xcf) {
      if (offset + 7 > buffer.length) return null;
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function getWebpDimensions(buffer: Buffer): { width: number; height: number } | null {
  const kind = buffer.toString('ascii', 12, 16);
  if (kind === 'VP8X' && buffer.length >= 30) {
    // `+` binds tighter than `|`, so these need explicit grouping around the
    // 24-bit little-endian read. Ungrouped, `(1 + b24) | b25 << 8` disagrees
    // with `1 + (b24 | b25 << 8)` whenever b24 is 0xFF, skewing the reported
    // size that the inline-media pixel guards depend on.
    const width = 1 + (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16));
    const height = 1 + (buffer[27]! | (buffer[28]! << 8) | (buffer[29]! << 16));
    return { width, height };
  }
  if (kind === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    return {
      width: 1 + (buffer[21] | (buffer[22] & 0x3f) << 8),
      height: 1 + (buffer[22] >> 6 | buffer[23] << 2 | (buffer[24] & 0x0f) << 10),
    };
  }
  return null;
}
