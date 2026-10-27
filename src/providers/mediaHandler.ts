import { logger } from '../utils/logger';
import { ProviderOperationError } from './errors';
import { createLazyPromise, HARD_MEDIA_MAX_BYTES } from './media';
import type { MediaAttachmentDescriptor } from '../core/MessageContext';
import { readMediaBuffer, saveMediaStream, saveMediaResponse, type SavedMedia } from '../utils/MediaStorage';

export interface MediaDownloader {
  download(descriptor: MediaAttachmentDescriptor, signal?: AbortSignal): Promise<MediaAttachmentDescriptor | null>;
  downloadAndSave(descriptor: MediaAttachmentDescriptor, downloadFn: (signal: AbortSignal) => Promise<AsyncIterable<Uint8Array> | Response>, signal?: AbortSignal): Promise<MediaAttachmentDescriptor | null>;
  createMediaReadyPromise(defaultDescriptor: MediaAttachmentDescriptor | null): Promise<void>;
  abortAll(error: Error): void;
}

export function createMediaDownloader(providerName: string): MediaDownloader {
  const controllers = new Set<AbortController>();

  const downloadAndSave = async (
    descriptor: MediaAttachmentDescriptor,
    downloadFn: (signal: AbortSignal) => Promise<AsyncIterable<Uint8Array> | Response>,
    signal?: AbortSignal
  ): Promise<MediaAttachmentDescriptor | null> => {
    if (descriptor.state === 'ready' && descriptor.mediaPath) return descriptor;
    if (descriptor.state === 'skipped') {
      if (signal) throw new ProviderOperationError(providerName, 'downloadMedia', descriptor.error || 'Media is unavailable.');
      return null;
    }

    const controller = new AbortController();
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(signal.reason));
    }
    controllers.add(controller);

    try {
      const source = await downloadFn(controller.signal);
      let saved: SavedMedia;
      if (source instanceof Response) {
        saved = await saveMediaResponse(source, {
          maxBytes: HARD_MEDIA_MAX_BYTES,
          contentLength: descriptor.sizeBytes ?? null,
          fallbackMime: descriptor.mimeType,
          signal: controller.signal,
        });
      } else {
        saved = await saveMediaStream(source, {
          maxBytes: HARD_MEDIA_MAX_BYTES,
          contentLength: descriptor.sizeBytes ?? null,
          fallbackMime: descriptor.mimeType,
          signal: controller.signal,
        });
      }
      descriptor.mediaPath = saved.path;
      descriptor.mimeType = saved.mime;
      descriptor.state = 'ready';
      descriptor.error = undefined;
      return descriptor;
    } catch (error) {
      descriptor.state = 'error';
      descriptor.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      logger.warn({ err: error, attachmentId: descriptor.id, provider: providerName }, 'Failed to download media');
      if (signal) throw new ProviderOperationError(providerName, 'downloadMedia', descriptor.error, error);
      return null;
    } finally {
      controllers.delete(controller);
    }
  };

  const download = async (_descriptor: MediaAttachmentDescriptor, _signal?: AbortSignal): Promise<MediaAttachmentDescriptor | null> => {
    throw new ProviderOperationError(providerName, 'downloadMedia', 'download() not implemented - use downloadAndSave() with a download function', undefined, 'UNSUPPORTED');
  };

  const createMediaReadyPromise = (defaultDescriptor: MediaAttachmentDescriptor | null): Promise<void> => {
    return createLazyPromise(async () => {
      if (defaultDescriptor) await downloadAndSave(defaultDescriptor, async () => { throw new Error('Not implemented'); }, undefined);
    });
  };

  const abortAll = (error: Error): void => {
    for (const controller of controllers) controller.abort(error);
    controllers.clear();
  };

  return { download, downloadAndSave, createMediaReadyPromise, abortAll };
}

export function createMediaDescriptor(
  id: string,
  index: number,
  origin: 'current' | 'quoted',
  providerId: string | undefined,
  filename: string | undefined,
  mimeType: string | undefined,
  sizeBytes: number | undefined
): MediaAttachmentDescriptor {
  return {
    id,
    index,
    origin,
    providerId,
    filename,
    mimeType,
    sizeBytes,
    state: sizeBytes && sizeBytes > HARD_MEDIA_MAX_BYTES ? 'skipped' : 'pending',
    error: sizeBytes && sizeBytes > HARD_MEDIA_MAX_BYTES ? `Media exceeds ${HARD_MEDIA_MAX_BYTES} bytes.` : undefined,
  };
}

export function createMediaSelector(
  descriptors: MediaAttachmentDescriptor[],
  downloadFn: (descriptor: MediaAttachmentDescriptor, signal?: AbortSignal) => Promise<MediaAttachmentDescriptor | null>,
  onSelect: (descriptor: MediaAttachmentDescriptor) => void
) {
  const selectMediaAttachment = async (attachmentId: string): Promise<MediaAttachmentDescriptor> => {
    const descriptor = descriptors.find(candidate => candidate.id === attachmentId);
    if (!descriptor) throw new ProviderOperationError('provider', 'selectMediaAttachment', `Unknown attachment: ${attachmentId}.`, undefined, 'INVALID_TARGET');
    const controller = new AbortController();
    const downloaded = await downloadFn(descriptor, controller.signal);
    if (!downloaded) throw new ProviderOperationError('provider', 'selectMediaAttachment', 'Attachment could not be downloaded.');
    onSelect(downloaded);
    return { ...downloaded };
  };

  const getMediaAttachment = (id: string) => descriptors.find(d => d.id === id);

  const downloadMedia = async (attachmentId?: string): Promise<Buffer | null> => {
    const id = attachmentId ?? descriptors[0]?.id;
    if (!id) return null;
    const descriptor = await selectMediaAttachment(id);
    return descriptor.mediaPath ? readMediaBuffer(descriptor.mediaPath, HARD_MEDIA_MAX_BYTES) : null;
  };

  return { selectMediaAttachment, getMediaAttachment, downloadMedia };
}