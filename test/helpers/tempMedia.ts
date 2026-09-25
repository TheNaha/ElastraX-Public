import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileTypeFromBuffer } from 'file-type';
import { assertSafeMediaPath, getTestWorkerPaths } from './paths';

export interface TempMediaFile {
  path: string;
  mime: string;
  bytes: number;
}

export function getTempMediaDir(): string {
  const configured = process.env.ELASTRAX_MEDIA_DIR?.trim();
  return assertSafeMediaPath(configured || getTestWorkerPaths().mediaDir);
}

export function createTempMediaDir(): string {
  const directory = getTempMediaDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export async function saveTempMedia(buffer: Buffer, fileName = `${randomUUID()}.bin`): Promise<TempMediaFile> {
  const directory = createTempMediaDir();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '-');
  const normalizedName = safeName === '.' || safeName === '..' ? `${randomUUID()}.bin` : safeName;
  const path = assertSafeMediaPath(join(directory, normalizedName));
  await writeFile(path, buffer);
  const typeInfo = await fileTypeFromBuffer(buffer);
  return { path, mime: typeInfo?.mime ?? 'application/octet-stream', bytes: buffer.byteLength };
}

export function cleanupTempMedia(directory = getTempMediaDir()): void {
  const safeDirectory = assertSafeMediaPath(directory);
  if (resolve(safeDirectory) === resolve(tmpdir())) throw new Error('Refusing to clean the entire temporary directory.');
  rmSync(safeDirectory, { recursive: true, force: true });
}

export async function withTempMedia<T>(callback: (directory: string) => T | Promise<T>): Promise<T> {
  const directory = createTempMediaDir();
  try {
    return await callback(directory);
  } finally {
    cleanupTempMedia(directory);
  }
}

export const withTempMediaDir = withTempMedia;
