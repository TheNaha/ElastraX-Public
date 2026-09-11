/**
 * @file src/utils/mediaResolve.ts
 * @description Single implementation of the "which media file does this tool
 * operate on?" dance that every media tool previously copy-pasted:
 *
 *   1. current message's cached file  →  2. quoted message's cached file
 *   →  3. wait for the background download (`ctx.mediaReady`) and retry
 *   →  4. optionally fall back to `ctx.downloadMedia()` (handles quoted
 *      messages whose provider never cached a path).
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import type { MessageContext } from '../core/MessageContext';

/** A located media file. At least one of `path` / `buffer` is always set. */
export interface ResolvedMedia {
  /** Path of the cached file on disk (preferred — avoids holding RAM). */
  path?: string;
  /** Mime type reported by the carrier message ('' when unknown). */
  mime: string;
  /** In-memory bytes when the file was fetched via ctx.downloadMedia(). */
  buffer?: Buffer;
}

export interface ResolveMediaOptions {
  /**
   * As a last resort, pull the bytes via ctx.downloadMedia() (works for the
   * current OR quoted message). Defaults to false.
   */
  useDownloader?: boolean;
  /** Hook invoked right before an on-demand download (e.g. a reaction emoji). */
  beforeDownload?: () => void | Promise<void>;
}

type MediaCarrier = { mediaPath?: string; mimeType?: string };

async function findOnDisk(ctx: MessageContext): Promise<ResolvedMedia | null> {
  const carriers: MediaCarrier[] = [
    { mediaPath: ctx.mediaPath, mimeType: ctx.mimeType },
    { mediaPath: ctx.quoted?.mediaPath, mimeType: ctx.quoted?.mimeType },
  ];
  for (const c of carriers) {
    if (c.mediaPath && existsSync(c.mediaPath)) {
      return { path: c.mediaPath, mime: c.mimeType || '' };
    }
  }
  return null;
}

/**
 * Resolve the media file a tool should operate on: current message first,
 * then the quoted message, waiting for the provider's background download
 * between attempts.
 */
export async function resolveTargetMedia(
  ctx: MessageContext,
  opts: ResolveMediaOptions = {},
): Promise<ResolvedMedia | null> {
  const direct = await findOnDisk(ctx);
  if (direct) return direct;

  // A background download may still be in flight — give it a chance to land.
  await ctx.mediaReady;
  const late = await findOnDisk(ctx);
  if (late) return late;

  if (opts.useDownloader && ctx.downloadMedia) {
    await opts.beforeDownload?.();
    const buffer = await ctx.downloadMedia();
    if (!buffer) return null;
    return { mime: ctx.mimeType || ctx.quoted?.mimeType || '', buffer };
  }

  return null;
}

/** Read the bytes of a {@link ResolvedMedia} regardless of how it was sourced. */
export async function loadMediaBytes(media: ResolvedMedia): Promise<Buffer> {
  if (media.buffer) return media.buffer;
  if (media.path) return readFile(media.path);
  throw new Error('ResolvedMedia has neither path nor buffer');
}
