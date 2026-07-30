/**
 * @file src/utils/MediaStorage.ts
 * @description Shared utility for saving media buffers to the local filesystem.
 *
 * Both WhatsApp and Discord providers need to persist downloaded media to
 * `./data/media/` with a unique filename. This module extracts that shared
 * logic to avoid duplication and ensure consistent behavior across providers.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { fileTypeFromBuffer } from 'file-type';
import { logger } from './logger';

import { ROOT_DIR } from '../core/constants';
const MEDIA_DIR = join(ROOT_DIR, 'data/media');

/** Result of a successful media save operation. */
export interface SavedMedia {
  /** Local filesystem path to the saved file. */
  path: string;
  /** Detected MIME type of the file. */
  mime: string;
}

/**
 * Saves a binary buffer to the `./data/media/` directory with a UUID-based filename.
 * Auto-detects the file extension from the buffer's magic bytes.
 *
 * @param buffer - The binary data to save.
 * @returns The saved file path and detected MIME type, or null on failure.
 */
export async function saveMediaBuffer(buffer: Buffer): Promise<SavedMedia | null> {
  try {
    if (!existsSync(MEDIA_DIR)) {
      await mkdir(MEDIA_DIR, { recursive: true });
    }

    const typeInfo = await fileTypeFromBuffer(buffer);
    const mime = typeInfo?.mime ?? 'application/octet-stream';
    const ext = typeInfo?.ext ?? 'bin';
    const filename = `${randomUUID()}.${ext}`;
    const filepath = join(MEDIA_DIR, filename);
    await writeFile(filepath, buffer);
    return { path: filepath, mime };
  } catch (err) {
    logger.error(err, '[MediaStorage] Failed to save buffer to disk');
    return null;
  }
}
