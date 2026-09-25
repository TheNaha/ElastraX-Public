import { join, relative, resolve, sep } from 'node:path';
import * as fsPromises from 'fs/promises';
import * as crypto from 'crypto';
import * as fileType from 'file-type';
import type { SavedMedia as ActualSavedMedia, SaveMediaStreamOptions as ActualSaveMediaStreamOptions, MediaQuotaResult as ActualMediaQuotaResult } from '../../src/utils/MediaStorage';
import { getTempMediaDir } from './tempMedia';

type MediaStorageModule = typeof import('../../src/utils/MediaStorage');

export async function saveMediaBuffer(buffer: Buffer): Promise<ActualSavedMedia | null> {
  try {
    const directory = getTempMediaDir();
    await fsPromises.mkdir(directory, { recursive: true });
    const typeInfo = await fileType.fileTypeFromBuffer(buffer);
    const path = join(directory, `${crypto.randomUUID()}.${typeInfo?.ext ?? 'bin'}`);
    await fsPromises.writeFile(path, buffer);
    return { path, mime: typeInfo?.mime ?? 'application/octet-stream', sizeBytes: buffer.byteLength, detectedMime: typeInfo?.mime };
  } catch {
    return null;
  }
}

function translatePath(sourceMediaRoot: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const resolved = resolve(value);
  if (resolved !== sourceMediaRoot && !resolved.startsWith(`${sourceMediaRoot}${sep}`)) return value;
  return join(getTempMediaDir(), relative(sourceMediaRoot, resolved));
}

function wrapPathMethod(sourceMediaRoot: string, method: (...args: unknown[]) => unknown) {
  return (...args: unknown[]) => method(...args.map((value) => translatePath(sourceMediaRoot, value)));
}

export function createMediaStorageFixture(actual: MediaStorageModule) {
  const sourceMediaRoot = resolve(String(actual.MEDIA_DIR));
  const saveMediaStream = actual.saveMediaStream;
  const saveMediaResponse = actual.saveMediaResponse;
  const readMediaBuffer = actual.readMediaBuffer;
  const reconcileMediaQuota = actual.reconcileMediaQuota;
  const pathMethods = new Set(['mkdir', 'chmod', 'open', 'readdir', 'rename', 'rm', 'stat', 'unlink', 'writeFile']);
  const fsMethods = fsPromises as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of pathMethods) {
    if (typeof fsMethods[name] === 'function') {
      const invoke = (...args: unknown[]) => fsMethods[name](...args);
      (actual.mediaStorageDeps as unknown as Record<string, unknown>)[name] = wrapPathMethod(sourceMediaRoot, invoke);
    }
  }
  (actual.mediaStorageDeps as unknown as Record<string, unknown>).randomUUID = (...args: unknown[]) => crypto.randomUUID(...(args as []));
  (actual.mediaStorageDeps as unknown as Record<string, unknown>).fileTypeFromBuffer = (...args: unknown[]) => fileType.fileTypeFromBuffer(...(args as [Buffer]));

  const translate = (value: unknown): unknown => translatePath(sourceMediaRoot, value);
  const mapSavedMedia = (value: ActualSavedMedia | null): ActualSavedMedia | null => {
    if (!value) return value;
    return { ...value, path: String(translate(value.path)) };
  };
  const mapQuotaResult = (value: ActualMediaQuotaResult): ActualMediaQuotaResult => ({
    ...value,
    deleted: value.deleted.map((path) => String(translate(path))),
  });
  const saveBuffer = async (...args: Parameters<MediaStorageModule['saveMediaBuffer']>): Promise<ActualSavedMedia | null> => {
    try {
      const buffer = args[0];
      const directory = getTempMediaDir();
      await fsPromises.mkdir(directory, { recursive: true });
      const typeInfo = await fileType.fileTypeFromBuffer(buffer);
      const mime = typeInfo?.mime ?? 'application/octet-stream';
      const extension = typeInfo?.ext ?? 'bin';
      const path = join(directory, `${crypto.randomUUID()}.${extension}`);
      await fsPromises.writeFile(path, buffer);
      return { path, mime, sizeBytes: buffer.byteLength, detectedMime: typeInfo?.mime };
    } catch {
      return null;
    }
  };

  const fixture = {
    ...actual,
    MEDIA_DIR: getTempMediaDir(),
    mediaStorageDeps: actual.mediaStorageDeps,
    saveMediaBuffer: saveBuffer,
    saveMediaStream: async (...args: Parameters<MediaStorageModule['saveMediaStream']>) => mapSavedMedia(await saveMediaStream(...args)),
    saveMediaResponse: async (...args: Parameters<MediaStorageModule['saveMediaResponse']>) => mapSavedMedia(await saveMediaResponse(...args)),
    readMediaBuffer: async (...args: Parameters<MediaStorageModule['readMediaBuffer']>) => readMediaBuffer(translate(args[0]) as string, args[1]),
    reconcileMediaQuota: async (...args: Parameters<MediaStorageModule['reconcileMediaQuota']>) => mapQuotaResult(await reconcileMediaQuota(...args)),
    deleteSavedMedia: async (path: string) => {
      const resolved = resolve(path);
      const tempRoot = resolve(getTempMediaDir());
      const sourcePath = String(translate(path));
      const sourceResolved = resolve(sourcePath);
      const sourcePathAllowed = sourceResolved === sourceMediaRoot || sourceResolved.startsWith(`${sourceMediaRoot}${sep}`);
      const tempPathAllowed = sourceResolved === tempRoot || sourceResolved.startsWith(`${tempRoot}${sep}`);
      const originalPathAllowed = resolved === sourceMediaRoot || resolved.startsWith(`${sourceMediaRoot}${sep}`) || resolved === tempRoot || resolved.startsWith(`${tempRoot}${sep}`);
      if (!sourcePathAllowed && !tempPathAllowed) return false;
      if (!originalPathAllowed) return false;
      try {
        const info = await actual.mediaStorageDeps.stat(sourcePath);
        if (!info.isFile()) return false;
        await actual.mediaStorageDeps.unlink(sourcePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
  };
  return fixture;
}

export type { ActualMediaQuotaResult as MediaQuotaResult, ActualSavedMedia as SavedMedia, ActualSaveMediaStreamOptions as SaveMediaStreamOptions };
