import { logger } from './logger';
import { join, resolve, sep } from 'node:path';
import {
  globalMediaByteBudget,
  globalMediaDownloadSlots,
  globalMediaIoSlots,
} from '../providers/media';
import {
  MEDIA_DIR,
  TYPE_DETECTION_BYTES,
  HARD_MEDIA_MAX_BYTES,
  NORMAL_MEDIA_MAX_BYTES,
  SavedMedia,
  SaveMediaStreamOptions,
  mediaStorageDeps,
  normalizeLimit,
  validateContentLength,
  initialReservation,
  normalizeFallbackMime,
  extensionForMime,
  throwIfAborted,
  MediaLimitError,
  reconcileMediaQuota,
  invalidateMediaDirCache,
} from './mediaShared';

let clearStaleMediaReferencesCallback: ((paths: string[]) => Promise<number>) | null = null;

export function setClearStaleMediaReferencesCallback(
  callback: (paths: string[]) => Promise<number>
): void {
  clearStaleMediaReferencesCallback = callback;
}

async function clearDeletedMediaReferences(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  if (clearStaleMediaReferencesCallback) {
    try {
      await clearStaleMediaReferencesCallback(paths);
    } catch (error) {
      logger.warn({ err: error }, '[MediaStorage] Failed to clear deleted media references');
    }
  }
}

export async function saveMediaBuffer(
  buffer: Buffer,
  options: Omit<SaveMediaStreamOptions, 'contentLength'> = {},
): Promise<SavedMedia | null> {
  const maxBytes = normalizeLimit(options.maxBytes, HARD_MEDIA_MAX_BYTES);
  if (buffer.length === 0 || buffer.length > maxBytes) {
    logger.warn({ sizeBytes: buffer.length, maxBytes }, '[MediaStorage] Rejected out-of-range buffer');
    return null;
  }
  const releaseSlot = await globalMediaDownloadSlots.acquire(1, options.signal);
  let releaseBytes: (() => void) | null = null;
  let tempPath: string | undefined;
  try {
    releaseBytes = await globalMediaByteBudget.acquire(buffer.length, options.signal);
    return await withMediaIoSlot(async () => {
      await ensureMediaDirectory();
      const id = mediaStorageDeps.randomUUID();
      tempPath = join(MEDIA_DIR, `.media-${id}.tmp`);
      await mediaStorageDeps.writeFile(tempPath, buffer, { mode: 0o600, flag: 'wx' });
      const typeInfo = await detectType(buffer.subarray(0, TYPE_DETECTION_BYTES));
      const mime = typeInfo?.mime || normalizeFallbackMime(options.fallbackMime);
      const extension = typeInfo?.ext || extensionForMime(mime);
      const finalPath = join(MEDIA_DIR, `${id}.${extension}`);
      const quota = await reconcileMediaQuota(buffer.length, tempPath);
      await clearDeletedMediaReferences(quota.deleted);
      await mediaStorageDeps.rename(tempPath, finalPath);
      await mediaStorageDeps.chmod(finalPath, 0o600).catch(error => logger.warn({ err: error }, '[MediaStorage] Failed to restrict media permissions'));
      return { path: finalPath, mime, sizeBytes: buffer.length, detectedMime: typeInfo?.mime };
    });
  } catch (error) {
    if (tempPath) await mediaStorageDeps.rm(tempPath, { force: true }).catch(() => undefined);
    logger.error({ err: error }, '[MediaStorage] Failed to save buffer');
    return null;
  } finally {
    releaseBytes?.();
    releaseSlot();
  }
}

export async function saveMediaStream(
  stream: AsyncIterable<Uint8Array>,
  options: SaveMediaStreamOptions = {},
): Promise<SavedMedia> {
  const maxBytes = normalizeLimit(options.maxBytes, HARD_MEDIA_MAX_BYTES);
  validateContentLength(options.contentLength, maxBytes);
  const releaseSlot = await globalMediaDownloadSlots.acquire(1, options.signal);
  let reservedBytes = initialReservation(options.contentLength, maxBytes);
  let releaseBytes: (() => void) | null = null;
  let tempPath: string | undefined;
  try {
    releaseBytes = await globalMediaByteBudget.acquire(reservedBytes, options.signal);
    await ensureMediaDirectory();
    tempPath = join(MEDIA_DIR, `.media-${mediaStorageDeps.randomUUID()}.tmp`);
    const handle = await mediaStorageDeps.open(tempPath, 'wx', 0o600);
    let bytesWritten = 0;
    const prefixChunks: Buffer[] = [];
    let prefixLength = 0;
    try {
      for await (const rawChunk of stream) {
        throwIfAborted(options.signal);
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        if (chunk.length === 0) continue;
        const nextBytes = bytesWritten + chunk.length;
        if (nextBytes > maxBytes) throw new MediaLimitError(nextBytes, maxBytes);
        if (nextBytes > reservedBytes) {
          const delta = nextBytes - reservedBytes;
          await globalMediaByteBudget.acquire(delta, options.signal);
          const previousRelease = releaseBytes;
          let released = false;
          releaseBytes = () => {
            if (released) return;
            released = true;
            previousRelease?.();
            globalMediaByteBudget.release(delta);
          };
          reservedBytes = nextBytes;
        }
        await writeAll(handle, chunk);
        bytesWritten = nextBytes;
        if (prefixLength < TYPE_DETECTION_BYTES) {
          const prefixChunk = chunk.subarray(0, TYPE_DETECTION_BYTES - prefixLength);
          prefixChunks.push(prefixChunk);
          prefixLength += prefixChunk.length;
        }
      }
      if (bytesWritten === 0) throw new Error('Media stream was empty.');
      await handle.sync();
    } finally {
      await handle.close();
    }

    const prefix = Buffer.concat(prefixChunks, prefixLength);
    const typeInfo = await detectType(prefix);
    const mime = typeInfo?.mime || normalizeFallbackMime(options.fallbackMime);
    const extension = typeInfo?.ext || extensionForMime(mime);
    const finalPath = join(MEDIA_DIR, `${mediaStorageDeps.randomUUID()}.${extension}`);
    await withMediaIoSlot(async () => {
      const quota = await reconcileMediaQuota(bytesWritten, tempPath);
      await clearDeletedMediaReferences(quota.deleted);
      await mediaStorageDeps.rename(tempPath!, finalPath);
    });
    await mediaStorageDeps.chmod(finalPath, 0o600).catch((error) => logger.warn({ err: error }, '[MediaStorage] Failed to restrict media permissions'));
    return {
      path: finalPath,
      mime,
      sizeBytes: bytesWritten,
      detectedMime: typeInfo?.mime,
    };
  } catch (error) {
    if (tempPath) await mediaStorageDeps.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    releaseBytes?.();
    releaseSlot();
  }
}

export async function saveMediaResponse(
  response: Response,
  options: SaveMediaStreamOptions = {},
): Promise<SavedMedia> {
  if (!response.ok) throw new Error(`Media request failed with HTTP ${response.status}.`);
  if (!response.body) throw new Error('Media response did not include a readable body.');
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
  return saveMediaStream(response.body, {
    ...options,
    contentLength,
    fallbackMime: options.fallbackMime || response.headers.get('content-type') || undefined,
  });
}

export async function readMediaBuffer(path: string, maxBytes = NORMAL_MEDIA_MAX_BYTES): Promise<Buffer> {
  const limit = normalizeLimit(maxBytes, NORMAL_MEDIA_MAX_BYTES);
  const info = await mediaStorageDeps.stat(path);
  if (!info.isFile()) throw new Error('Media path is not a regular file.');
  if (info.size > limit) throw new MediaLimitError(info.size, limit);
  const handle = await mediaStorageDeps.open(path, 'r');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit - total + 1));
      if (buffer.length === 0) break;
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw new MediaLimitError(total, limit);
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return Buffer.concat(chunks, total);
}

export async function deleteSavedMedia(path: string): Promise<boolean> {
  const mediaRoot = resolve(MEDIA_DIR);
  const target = resolve(path);
  if (target !== mediaRoot && !target.startsWith(`${mediaRoot}${sep}`)) return false;
  try {
    const info = await mediaStorageDeps.stat(target);
    if (!info.isFile()) return false;
    await mediaStorageDeps.unlink(target);
    invalidateMediaDirCache();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function detectAudioMimeType(buffer: Buffer): Promise<string | null> {
  if (buffer.length === 0) return null;
  try {
    const info = await mediaStorageDeps.fileTypeFromBuffer(buffer.subarray(0, TYPE_DETECTION_BYTES));
    return info?.mime?.startsWith('audio/') ? info.mime : null;
  } catch {
    return null;
  }
}

export function isAudioMagic(buffer: Buffer, mimeType?: string): boolean {
  if (buffer.length < 4) return false;
  const normalized = (mimeType || '').split(';', 1)[0].trim().toLowerCase();
  if (normalized === 'audio/mpeg' && (buffer.toString('ascii', 0, 3) === 'ID3' || buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0)) return true;
  if (buffer.toString('ascii', 0, 4) === 'OggS') return true;
  if (buffer.toString('ascii', 0, 4) === 'fLaC') return true;
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') return true;
  if (normalized === 'audio/aac' && buffer[0] === 0xff && (buffer[1]! & 0xf6) === 0xf0) return true;
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return true;
  return false;
}

async function ensureMediaDirectory(): Promise<void> {
  await mediaStorageDeps.mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
  await mediaStorageDeps.chmod(MEDIA_DIR, 0o700);
}

async function withMediaIoSlot<T>(operation: () => Promise<T>): Promise<T> {
  const release = await globalMediaIoSlots.acquire(1);
  try {
    return await operation();
  } finally {
    release();
  }
}

async function writeAll(handle: { write(buffer: Uint8Array): Promise<{ bytesWritten: number }> }, data: Buffer): Promise<void> {
  let written = 0;
  while (written < data.length) {
    const result = await handle.write(data.subarray(written));
    if (result.bytesWritten <= 0) throw new Error('Unable to write media stream.');
    written += result.bytesWritten;
  }
}

async function detectType(prefix: Buffer): Promise<{ mime: string; ext: string } | null> {
  if (prefix.length === 0) return null;
  try {
    const info = await mediaStorageDeps.fileTypeFromBuffer(prefix);
    return info ? { mime: info.mime, ext: info.ext } : null;
  } catch {
    return null;
  }
}

// Re-exports for backward compatibility with tests
export { MEDIA_DIR, TYPE_DETECTION_BYTES, mediaStorageDeps, reconcileMediaQuota };
export type { SavedMedia, SaveMediaStreamOptions, MediaQuotaResult } from './mediaShared';