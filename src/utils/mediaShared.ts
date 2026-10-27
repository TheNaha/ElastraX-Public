import { existsSync } from 'node:fs';
import { stat, unlink, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
export const MEDIA_DIR = resolve(process.env.ELASTRAX_MEDIA_DIR || join(process.cwd(), 'data/media'));
export const TYPE_DETECTION_BYTES = 4100;
export const DEFAULT_STORAGE_QUOTA_BYTES = 2048 * 1024 * 1024;
export const DEFAULT_STORAGE_MAX_FILES = 10_000;
export const TEMP_FILE_GRACE_MS = 5 * 60_000;
export const HARD_MEDIA_MAX_BYTES = 200 * 1024 * 1024;
export const NORMAL_MEDIA_MAX_BYTES = 32 * 1024 * 1024;

/** In-memory cache of media directory totals to avoid O(n) rescans on every save. */
interface MediaDirCache {
  totalBytes: number;
  fileCount: number;
  at: number;
}
const MEDIA_DIR_CACHE_TTL_MS = 60_000;
let mediaDirCache: MediaDirCache | null = null;

export function invalidateMediaDirCache(): void {
  mediaDirCache = null;
}

export interface SavedMedia {
  path: string;
  mime: string;
  sizeBytes: number;
  detectedMime?: string;
}

export interface SaveMediaStreamOptions {
  maxBytes?: number;
  fallbackMime?: string;
  contentLength?: number | null;
  signal?: AbortSignal;
}

export interface MediaQuotaResult {
  bytes: number;
  files: number;
  deleted: string[];
}

export interface PruneMediaOptions {
  now?: number;
  clearReferences?: boolean;
}

export const mediaStorageDeps = {
  mkdir: (() => import('node:fs/promises').then(m => m.mkdir)) as unknown as typeof import('node:fs/promises').mkdir,
  chmod: (() => import('node:fs/promises').then(m => m.chmod)) as unknown as typeof import('node:fs/promises').chmod,
  open: (() => import('node:fs/promises').then(m => m.open)) as unknown as typeof import('node:fs/promises').open,
  readdir,
  rename: (() => import('node:fs/promises').then(m => m.rename)) as unknown as typeof import('node:fs/promises').rename,
  rm: (() => import('node:fs/promises').then(m => m.rm)) as unknown as typeof import('node:fs/promises').rm,
  stat,
  unlink,
  writeFile: (() => import('node:fs/promises').then(m => m.writeFile)) as unknown as typeof import('node:fs/promises').writeFile,
  randomUUID: (() => import('node:crypto').then(m => m.randomUUID)) as unknown as typeof import('node:crypto').randomUUID,
  fileTypeFromBuffer: (() => import('file-type').then(m => m.fileTypeFromBuffer)) as unknown as typeof import('file-type').fileTypeFromBuffer,
};

export const mediaCleanupDeps = {
  stat,
  unlink,
  existsSync,
  readdir,
};

export function storageQuotaBytes(): number {
  const raw = process.env.MEDIA_STORAGE_MAX_MB?.trim();
  if (raw === '-1') return -1;
  const parsed = raw === undefined ? DEFAULT_STORAGE_QUOTA_BYTES / (1024 * 1024) : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STORAGE_QUOTA_BYTES;
  return Math.floor(parsed * 1024 * 1024);
}

export function storageMaxFiles(): number {
  const parsed = Number(process.env.MEDIA_STORAGE_MAX_FILES);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_STORAGE_MAX_FILES;
}

export function normalizeLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error('Media byte limit must be a positive safe integer.');
  return Math.min(resolved, HARD_MEDIA_MAX_BYTES);
}

export function validateContentLength(contentLength: number | null | undefined, maxBytes: number): void {
  if (contentLength === undefined || contentLength === null) return;
  if (!Number.isFinite(contentLength) || contentLength < 0) return;
  if (contentLength > maxBytes) throw new MediaLimitError(contentLength, maxBytes);
}

export function initialReservation(contentLength: number | null | undefined, maxBytes: number): number {
  if (contentLength !== undefined && contentLength !== null && Number.isFinite(contentLength) && contentLength > 0) {
    return Math.min(Math.ceil(contentLength), maxBytes);
  }
  return maxBytes;
}

export function normalizeFallbackMime(mimeType?: string): string {
  const normalized = (mimeType || '').split(';', 1)[0].trim().toLowerCase();
  return /^[\w.+-]+\/[\w.+-]+$/.test(normalized) ? normalized : 'application/octet-stream';
}

export function extensionForMime(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split('+')[0] || 'bin';
  const normalized = subtype.replace(/[^a-z0-9]/g, '').slice(0, 12);
  return normalized || 'bin';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Media download aborted.');
}

export class MediaLimitError extends Error {
  readonly actual: number;
  readonly limit: number;

  constructor(actual: number, limit: number) {
    super(`Media size ${actual} bytes exceeds limit ${limit} bytes`);
    this.name = 'MediaLimitError';
    this.actual = actual;
    this.limit = limit;
  }
}

export async function reconcileMediaQuota(incomingBytes = 0, excludedPath?: string, incomingFiles = 1): Promise<MediaQuotaResult> {
  const quotaBytes = storageQuotaBytes();
  const maxFiles = storageMaxFiles();
  const now = Date.now();

  // Fast path: use in-memory cache when under quota, avoiding an O(n) directory scan on every save.
  const cache = mediaDirCache;
  // Only use the cache when an excludedPath is provided (production callers
  // always pass tempPath). Tests call without it and mock the filesystem,
  // so a shared cache would return stale data across tests.
  if (excludedPath && cache && now - cache.at < MEDIA_DIR_CACHE_TTL_MS) {
    const projectedBytes = cache.totalBytes + incomingBytes;
    const projectedFiles = cache.fileCount + incomingFiles;
    if (projectedBytes <= quotaBytes && projectedFiles <= maxFiles) {
      return { bytes: projectedBytes, files: projectedFiles, deleted: [] };
    }
  }

  let entries: string[];
  try {
    entries = await mediaStorageDeps.readdir(MEDIA_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (incomingBytes > quotaBytes && quotaBytes >= 0) throw new MediaLimitError(incomingBytes, quotaBytes);
      mediaDirCache = { totalBytes: incomingBytes, fileCount: incomingFiles, at: now };
      return { bytes: incomingBytes, files: incomingFiles, deleted: [] };
    }
    throw error;
  }
  const excluded = excludedPath ? resolve(excludedPath) : undefined;
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const name of entries) {
    const candidate = resolve(join(MEDIA_DIR, name));
    if (excluded && candidate === excluded) continue;
    if (name.startsWith('.media-') && name.endsWith('.tmp')) {
      const tempPath = join(MEDIA_DIR, name);
      let ageMs: number;
      try {
        ageMs = Date.now() - (await mediaStorageDeps.stat(tempPath)).mtimeMs;
      } catch {
        continue;
      }
      if (ageMs >= TEMP_FILE_GRACE_MS) {
        await mediaStorageDeps.unlink(tempPath).catch(() => undefined);
      }
      continue;
    }
    try {
      const info = await mediaStorageDeps.stat(join(MEDIA_DIR, name));
      if (info.isFile()) files.push({ path: join(MEDIA_DIR, name), size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      continue;
    }
  }
  if (incomingBytes > quotaBytes && quotaBytes >= 0) throw new MediaLimitError(incomingBytes, quotaBytes);
  if (incomingFiles > maxFiles) throw new Error(`Media storage file quota exceeded (${maxFiles} files).`);
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  let fileCount = files.length;
  const deleted: string[] = [];
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of files) {
    const overBytes = quotaBytes >= 0 && bytes + incomingBytes > quotaBytes;
    const overFiles = fileCount + incomingFiles > maxFiles;
    if (!overBytes && !overFiles) break;
    try {
      await mediaStorageDeps.unlink(file.path);
      deleted.push(file.path);
      bytes -= file.size;
      fileCount--;
    } catch {
      continue;
    }
  }
  if (quotaBytes >= 0 && bytes + incomingBytes > quotaBytes) {
    throw new Error(`Media storage quota exceeded (${bytes + incomingBytes} > ${quotaBytes} bytes).`);
  }
  if (fileCount + incomingFiles > maxFiles) throw new Error(`Media storage file quota exceeded (${maxFiles} files).`);
  mediaDirCache = { totalBytes: bytes, fileCount: fileCount, at: now };
  return { bytes, files: fileCount, deleted };
}