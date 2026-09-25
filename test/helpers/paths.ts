import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const rawExistsSync = existsSync;
const rawMkdirSync = mkdirSync;
const rawMkdtempSync = mkdtempSync;
const rawReaddirSync = readdirSync;
const rawReadFileSync = readFileSync;
const rawRealpathSync = realpathSync;
const rawRmSync = rmSync;
const rawStatSync = statSync;

export const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..');
export const REPOSITORY_DATA_DIR = resolve(REPOSITORY_ROOT, 'data');
export const REPOSITORY_DATABASE_PATH = resolve(REPOSITORY_DATA_DIR, 'bot.db');

export interface TestWorkerPaths {
  id: string;
  root: string;
  dbPath: string;
  mediaDir: string;
  fixturesDir: string;
  downloadsDir: string;
  ffmpegDir: string;
}

export interface RepositoryDataSnapshot {
  entries: Record<string, { size: number; mtimeMs: number; hash?: string }>;
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' || (pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
}

function normalizePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error('A filesystem path is required.');
  if (trimmed.includes('\0')) throw new Error('Filesystem paths cannot contain NUL bytes.');
  if (trimmed === ':memory:') return trimmed;
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) throw new Error(`URI paths are not allowed: ${trimmed}`);
  return resolve(REPOSITORY_ROOT, trimmed);
}

export function assertNoRepositorySymlink(normalizedPath: string): void {
  let existingPath = normalizedPath;
  while (!rawExistsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) return;
    existingPath = parent;
  }
  const realPath = rawRealpathSync(existingPath);
  if (isWithin(REPOSITORY_ROOT, realPath)) {
    throw new Error(`Refusing path that resolves inside the repository: ${normalizedPath}`);
  }
}

export function isRepositoryDataPath(rawPath: string): boolean {
  const normalized = normalizePath(rawPath);
  return normalized !== ':memory:' && isWithin(REPOSITORY_DATA_DIR, normalized);
}

export function assertSafeDatabasePath(rawPath: string | undefined): string {
  const value = rawPath?.trim() || ':memory:';
  const normalized = normalizePath(value);
  if (normalized !== ':memory:' && isWithin(REPOSITORY_ROOT, normalized)) {
    throw new Error(`Refusing database path inside the repository: ${normalized}`);
  }
  if (normalized !== ':memory:') assertNoRepositorySymlink(normalized);
  return normalized;
}

export function assertSafeMediaPath(rawPath: string | undefined): string {
  const value = rawPath?.trim();
  if (!value) throw new Error('A media directory is required.');
  const normalized = normalizePath(value);
  if (normalized === ':memory:') throw new Error('A filesystem media directory is required.');
  if (isWithin(REPOSITORY_ROOT, normalized)) {
    throw new Error(`Refusing media path inside the repository: ${normalized}`);
  }
  assertNoRepositorySymlink(normalized);
  return normalized;
}

function safeWorkerId(): string {
  const candidate = process.env.BUN_TEST_WORKER_ID
    || process.env.BUN_TEST_WORKER_INDEX
    || process.env.TEST_WORKER_INDEX
    || String(process.pid);
  const sanitized = candidate.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
  return sanitized || String(process.pid);
}

function createWorkerPaths(): TestWorkerPaths {
  const id = `${safeWorkerId()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const root = rawMkdtempSync(join(tmpdir(), `elastrax-test-${id}-`));
  const paths: TestWorkerPaths = {
    id,
    root,
    dbPath: join(root, 'db', 'worker.db'),
    mediaDir: join(root, 'media'),
    fixturesDir: join(root, 'fixtures'),
    downloadsDir: join(root, 'downloads'),
    ffmpegDir: join(root, 'ffmpeg'),
  };
  for (const directory of [join(root, 'db'), paths.mediaDir, paths.fixturesDir, paths.downloadsDir, paths.ffmpegDir]) {
    rawMkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  assertSafeDatabasePath(paths.dbPath);
  assertSafeMediaPath(paths.mediaDir);
  return paths;
}

let workerPaths: TestWorkerPaths | undefined;

export function getTestWorkerPaths(): TestWorkerPaths {
  workerPaths ??= createWorkerPaths();
  return workerPaths;
}

export function cleanupTestWorkerPaths(paths: TestWorkerPaths = getTestWorkerPaths()): void {
  const root = resolve(paths.root);
  const tempRoot = resolve(tmpdir());
  if (!isWithin(tempRoot, root) || !root.includes(`${sep}elastrax-test-`)) {
    throw new Error(`Refusing to clean non-test path: ${root}`);
  }
  rawRmSync(root, { recursive: true, force: true });
  if (workerPaths?.root === paths.root) workerPaths = undefined;
}

function collectRepositoryDataEntries(directory: string, current = ''): Record<string, { size: number; mtimeMs: number; hash?: string }> {
  if (!rawExistsSync(directory)) return {};
  const entries: Record<string, { size: number; mtimeMs: number; hash?: string }> = {};
  for (const item of rawReaddirSync(directory, { withFileTypes: true })) {
    const relativePath = current ? join(current, item.name) : item.name;
    const absolutePath = join(directory, item.name);
    if (item.isDirectory()) {
      Object.assign(entries, collectRepositoryDataEntries(absolutePath, relativePath));
      continue;
    }
    if (!item.isFile()) continue;
    const info = rawStatSync(absolutePath);
    const hash = /^bot\.db(?:-|$)/.test(relativePath) ? createHash('sha256').update(rawReadFileSync(absolutePath)).digest('hex') : undefined;
    entries[relativePath] = { size: info.size, mtimeMs: info.mtimeMs, hash };
  }
  return entries;
}

export function captureRepositoryDataSnapshot(): RepositoryDataSnapshot {
  return { entries: collectRepositoryDataEntries(REPOSITORY_DATA_DIR) };
}

export function assertRepositoryDataUnchanged(snapshot: RepositoryDataSnapshot): void {
  const current = collectRepositoryDataEntries(REPOSITORY_DATA_DIR);
  const before = snapshot.entries;
  const names = new Set([...Object.keys(before), ...Object.keys(current)]);
  for (const name of names) {
    const initial = before[name];
    const latest = current[name];
    if (!initial || !latest || initial.size !== latest.size || initial.mtimeMs !== latest.mtimeMs || initial.hash !== latest.hash) {
      throw new Error(`Repository data changed during test execution: data/${name}`);
    }
  }
}

export const getWorkerPaths = getTestWorkerPaths;

export function getTestWorkerId(paths: TestWorkerPaths = getTestWorkerPaths()): string {
  return paths.id;
}

export function repositoryDatabaseExists(): boolean {
  return rawExistsSync(REPOSITORY_DATABASE_PATH);
}
