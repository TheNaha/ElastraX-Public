import { mock, spyOn } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { REPOSITORY_DATA_DIR, REPOSITORY_ROOT, type TestWorkerPaths, getTestWorkerPaths } from './paths';
import * as nodeFs from 'node:fs';
import * as nodeFsPromises from 'node:fs/promises';

type AnyFunction = (...args: unknown[]) => unknown;
const guardMarker = Symbol('elastrax-test-fs-guard');
type GuardedFunction = AnyFunction & { [guardMarker]?: true };

function toPath(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof URL) return fileURLToPath(value);
  return undefined;
}

function redirectPath(value: unknown, paths: TestWorkerPaths): unknown {
  const rawPath = toPath(value);
  if (!rawPath) return value;
  const dataRoot = resolve(REPOSITORY_DATA_DIR);
  const mediaRoot = resolve(REPOSITORY_DATA_DIR, 'media');
  const workerDataRoot = join(paths.root, 'data');
  const absolute = resolve(REPOSITORY_ROOT, rawPath);
  const legacyRoots: Record<string, string> = {
    [resolve(tmpdir(), 'elastrax-ffmpeg')]: paths.ffmpegDir,
    [resolve(tmpdir(), 'elastrax-downloads')]: paths.downloadsDir,
  };
  for (const [legacyRoot, replacement] of Object.entries(legacyRoots)) {
    const resolvedLegacyRoot = resolve(legacyRoot);
    if (absolute === resolvedLegacyRoot || absolute.startsWith(`${resolvedLegacyRoot}${sep}`)) {
      const suffix = relative(resolvedLegacyRoot, absolute);
      return suffix ? join(replacement, suffix) : replacement;
    }
  }
  const relativePath = relative(dataRoot, absolute);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return value;
  if (absolute === mediaRoot || relativePath === 'media' || relativePath.startsWith(`media${sep}`)) {
    const suffix = relativePath === 'media' ? '' : relativePath.slice('media/'.length);
    return suffix ? join(paths.mediaDir, suffix) : paths.mediaDir;
  }
  if (absolute === resolve(dataRoot, 'bot.db') || absolute === resolve(dataRoot, 'bot.db-wal') || absolute === resolve(dataRoot, 'bot.db-shm')) {
    if (absolute.endsWith('-wal')) return `${paths.dbPath}-wal`;
    if (absolute.endsWith('-shm')) return `${paths.dbPath}-shm`;
    return paths.dbPath;
  }
  return join(workerDataRoot, relativePath);
}

function wrapFunctions(source: Record<string, unknown>, pathIndexes: Record<string, number[]>, paths: TestWorkerPaths): Record<string, unknown> {
  const wrapped: Record<string, unknown> = { ...source };
  for (const [name, indexes] of Object.entries(pathIndexes)) {
    const method = source[name];
    if (typeof method !== 'function') continue;
    wrapped[name] = (...args: unknown[]) => {
      const next = args.slice();
      for (const index of indexes) {
        if (index < next.length) next[index] = redirectPath(next[index], paths);
      }
      return (method as AnyFunction)(...next);
    };
  }
  return wrapped;
}

const promisePathIndexes: Record<string, number[]> = {
  access: [0], appendFile: [0], chmod: [0], chown: [0], copyFile: [0, 1], cp: [0, 1], lchmod: [0], lchown: [0],
  link: [0, 1], lstat: [0], lutimes: [0], mkdir: [0], mkdtemp: [0], open: [0], openAsBlob: [0], opendir: [0],
  readFile: [0], readdir: [0], readlink: [0], realpath: [0], rename: [0, 1], rm: [0], rmdir: [0], stat: [0],
  statfs: [0], symlink: [1], truncate: [0], unlink: [0], utimes: [0], watch: [0], writeFile: [0],
};

const syncPathIndexes: Record<string, number[]> = {
  accessSync: [0], appendFileSync: [0], chmodSync: [0], chownSync: [0], copyFileSync: [0, 1], cpSync: [0, 1],
  createReadStream: [0], createWriteStream: [0], existsSync: [0], lchmodSync: [0], lchownSync: [0], linkSync: [0, 1],
  lstatSync: [0], lutimesSync: [0], mkdirSync: [0], mkdtempSync: [0], openSync: [0], readFileSync: [0], readdirSync: [0],
  readlinkSync: [0], realpathSync: [0], renameSync: [0, 1], rmSync: [0], rmdirSync: [0], statSync: [0], statfsSync: [0],
  symlinkSync: [1], truncateSync: [0], unlinkSync: [0], utimesSync: [0], watchSync: [0], writeFileSync: [0],
};

export function installFilesystemSpies(paths: TestWorkerPaths = getTestWorkerPaths()): void {
  const wrapNamespace = (source: Record<string, unknown>, pathIndexes: Record<string, number[]>): void => {
    for (const [name, indexes] of Object.entries(pathIndexes)) {
      const method = source[name];
      if (typeof method !== 'function' || (method as GuardedFunction)[guardMarker]) continue;
      const spy = spyOn(source, name);
      const implementation = ((...args: unknown[]) => {
        const next = args.slice();
        for (const index of indexes) {
          if (index < next.length) next[index] = redirectPath(next[index], paths);
        }
        return (method as AnyFunction)(...next);
      }) as GuardedFunction;
      implementation[guardMarker] = true;
      (spy as unknown as GuardedFunction)[guardMarker] = true;
      spy.mockImplementation(implementation as never);
    }
  };
  wrapNamespace(nodeFsPromises as unknown as Record<string, unknown>, promisePathIndexes);
  wrapNamespace((nodeFs as unknown as { promises: Record<string, unknown> }).promises, promisePathIndexes);
  wrapNamespace(nodeFs as unknown as Record<string, unknown>, syncPathIndexes);
  const currentFile = Bun.file as unknown as GuardedFunction;
  if (!currentFile[guardMarker]) {
    const originalBunFile = currentFile as unknown as typeof Bun.file;
    const fileWrapper = ((path: string | URL, options?: BlobPropertyBag) => originalBunFile(redirectPath(path, paths) as string, options)) as typeof Bun.file;
    (fileWrapper as unknown as GuardedFunction)[guardMarker] = true;
    Bun.file = fileWrapper;
  }
  const currentWrite = Bun.write as unknown as GuardedFunction;
  if (!currentWrite[guardMarker]) {
    const originalBunWrite = currentWrite as unknown as typeof Bun.write;
    const simpleWrite = originalBunWrite as unknown as (destination: string, input: unknown, options?: unknown) => Promise<number>;
    const writeWrapper = ((destination: string | URL, input: unknown, options?: unknown) => simpleWrite(redirectPath(destination, paths) as string, input, options)) as typeof Bun.write;
    (writeWrapper as unknown as GuardedFunction)[guardMarker] = true;
    Bun.write = writeWrapper;
  }
}

export function installFilesystemGuards(paths: TestWorkerPaths = getTestWorkerPaths()): void {
  const promises = wrapFunctions(nodeFsPromises as unknown as Record<string, unknown>, promisePathIndexes, paths);
  const sync = wrapFunctions(nodeFs as unknown as Record<string, unknown>, syncPathIndexes, paths);
  mock.module('node:fs/promises', () => promises);
  mock.module('node:fs', () => sync);
}
