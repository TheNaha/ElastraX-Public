import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isRepositoryDataPath, assertSafeDatabasePath, assertSafeMediaPath, getTestWorkerPaths, REPOSITORY_ROOT, type TestWorkerPaths } from './paths';

const APPLICATION_ENV_PREFIXES = [
  'ANTHROPIC_',
  'AI_',
  'APP_',
  'BOT_',
  'CONTEXT_',
  'DEFAULT_SYSTEM_',
  'DIGEST_',
  'DISCORD_',
  'DOWNLOAD_',
  'ELASTRAX_',
  'EMBEDDING_',
  'ENABLE_',
  'FIXTURE_',
  'GOOGLE_',
  'HF_',
  'HUGGINGFACE_',
  'JELLYFIN_',
  'JINA_',
  'LOG_',
  'MEDIA_',
  'MENFESS_',
  'MODAL_',
  'OPENAI_',
  'RATE_LIMIT_',
  'ROLE_PRIV_',
  'SEARRX_',
  'SEARRXNG_',
  'SEERR_',
  'TOOL_',
  'TRANSCRIBE_',
  'WEBHOOK_',
  'WHATSAPP_',
  'YTDLP_',
];

const APPLICATION_ENV_KEYS = new Set(['NODE_ENV']);
const HARNESS_ENV_KEYS = new Set([
  'BUN_CONFIG_DISABLE_DOTENV',
  'ELASTRAX_TEST',
  'ELASTRAX_TEST_ROOT',
  'ELASTRAX_TEST_WORKER',
  'ELASTRAX_DB_PATH',
  'ELASTRAX_MEDIA_DIR',
  'ELASTRAX_TEST_MEDIA_DIR',
  'ELASTRAX_TEST_FIXTURES_DIR',
  'ELASTRAX_TEST_DOWNLOAD_DIR',
  'ELASTRAX_TEST_FFMPEG_DIR',
]);
const SYSTEM_ENV_KEYS = new Set([
  'BUN_INSTALL', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH', 'CI', 'COLORTERM', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'NODE_OPTIONS', 'NO_COLOR', 'PATH', 'PWD', 'SHELL', 'TERM', 'TMP', 'TMPDIR', 'TEMP', 'TZ', 'USER',
]);

export type EnvironmentSnapshot = Record<string, string | undefined>;

function dotEnvKeys(): Set<string> {
  const keys = new Set<string>();
  let files: string[] = [];
  try {
    files = readdirSync(REPOSITORY_ROOT).filter((name) => name === '.env' || name.startsWith('.env.'));
  } catch {
    return keys;
  }
  for (const file of files) {
    let content = '';
    try {
      content = readFileSync(join(REPOSITORY_ROOT, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match?.[1]) keys.add(match[1]);
    }
  }
  return keys;
}

export function clearDotEnvLeakage(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of dotEnvKeys()) {
    if (!SYSTEM_ENV_KEYS.has(key) && !HARNESS_ENV_KEYS.has(key)) delete env[key];
  }
}

function isApplicationEnvironmentKey(key: string): boolean {
  return APPLICATION_ENV_KEYS.has(key) || APPLICATION_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function clearApplicationEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (isApplicationEnvironmentKey(key) && !HARNESS_ENV_KEYS.has(key)) delete env[key];
  }
}

export function configureTestEnvironment(paths: TestWorkerPaths = getTestWorkerPaths(), env: NodeJS.ProcessEnv = process.env): void {
  clearDotEnvLeakage(env);
  clearApplicationEnvironment(env);
  env.NODE_ENV = 'test';
  env.BUN_CONFIG_DISABLE_DOTENV = '1';
  env.ELASTRAX_TEST = '1';
  env.ELASTRAX_TEST_ROOT = paths.root;
  env.ELASTRAX_TEST_WORKER = paths.id;
  env.ELASTRAX_DB_PATH = assertSafeDatabasePath(paths.dbPath);
  env.ELASTRAX_MEDIA_DIR = assertSafeMediaPath(paths.mediaDir);
  env.ELASTRAX_TEST_MEDIA_DIR = env.ELASTRAX_MEDIA_DIR;
  env.ELASTRAX_TEST_FIXTURES_DIR = assertSafeMediaPath(paths.fixturesDir);
  env.ELASTRAX_TEST_DOWNLOAD_DIR = assertSafeMediaPath(paths.downloadsDir);
  env.ELASTRAX_TEST_FFMPEG_DIR = assertSafeMediaPath(paths.ffmpegDir);
  env.AI_API_BASE_URL = 'https://test-ai.example.com/v1';
  env.AI_API_KEY = 'test-key';
  env.AI_MODEL_NAME = 'test-model';
  env.WEBHOOK_ENABLED = 'false';
}

export function snapshotEnvironment(env: NodeJS.ProcessEnv = process.env): EnvironmentSnapshot {
  return { ...env } as EnvironmentSnapshot;
}

export function restoreEnvironment(snapshot: EnvironmentSnapshot, env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (!(key in snapshot)) delete env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined) env[key] = value;
  }
}

export async function withEnvironment<T>(
  overrides: EnvironmentSnapshot,
  callback: () => T | Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const snapshot = snapshotEnvironment(env);
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    return await callback();
  } finally {
    restoreEnvironment(snapshot, env);
  }
}

type EnvironmentRecord = Record<string, string | undefined>;

type EnvironmentDescriptor = PropertyDescriptor | undefined;

let guardState: {
  originalDescriptor: EnvironmentDescriptor;
  raw: EnvironmentRecord;
  proxy: NodeJS.ProcessEnv;
  restore: () => void;
} | undefined;

function unwrapEnvironment(value: unknown, currentProxy: NodeJS.ProcessEnv, currentRaw: EnvironmentRecord): EnvironmentRecord {
  if (value === currentProxy) return currentRaw;
  if (value && typeof value === 'object') return value as EnvironmentRecord;
  return currentRaw;
}

export function installProcessEnvironmentGuard(): () => void {
  if (guardState) return guardState.restore;

  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'env');
  const fallbackPaths = getTestWorkerPaths();
  let raw = process.env as EnvironmentRecord;
  let proxy: NodeJS.ProcessEnv;

  const ensureSafeDefaults = (target: EnvironmentRecord): void => {
    target.ELASTRAX_DB_PATH = assertSafeDatabasePath(target.ELASTRAX_DB_PATH || fallbackPaths.dbPath);
    target.ELASTRAX_MEDIA_DIR = assertSafeMediaPath(target.ELASTRAX_MEDIA_DIR || fallbackPaths.mediaDir);
    target.ELASTRAX_TEST_ROOT = assertSafeMediaPath(target.ELASTRAX_TEST_ROOT || fallbackPaths.root);
    target.ELASTRAX_TEST_FIXTURES_DIR = assertSafeMediaPath(target.ELASTRAX_TEST_FIXTURES_DIR || fallbackPaths.fixturesDir);
    target.ELASTRAX_TEST_DOWNLOAD_DIR = assertSafeMediaPath(target.ELASTRAX_TEST_DOWNLOAD_DIR || fallbackPaths.downloadsDir);
    target.ELASTRAX_TEST_FFMPEG_DIR = assertSafeMediaPath(target.ELASTRAX_TEST_FFMPEG_DIR || fallbackPaths.ffmpegDir);
    if (target.FIXTURE_DUMP_DIR && isRepositoryDataPath(target.FIXTURE_DUMP_DIR)) {
      throw new Error(`Refusing fixture path inside repository data: ${target.FIXTURE_DUMP_DIR}`);
    }
  };

  const safeDirectoryFallbacks: Record<string, string> = {
    ELASTRAX_MEDIA_DIR: fallbackPaths.mediaDir,
    ELASTRAX_TEST_ROOT: fallbackPaths.root,
    ELASTRAX_TEST_FIXTURES_DIR: fallbackPaths.fixturesDir,
    ELASTRAX_TEST_DOWNLOAD_DIR: fallbackPaths.downloadsDir,
    ELASTRAX_TEST_FFMPEG_DIR: fallbackPaths.ffmpegDir,
  };
  const hasSafeDirectory = (property: string): boolean => Object.prototype.hasOwnProperty.call(safeDirectoryFallbacks, property);

  const makeProxy = (target: EnvironmentRecord): NodeJS.ProcessEnv => new Proxy(target, {
    defineProperty(targetObject, property, descriptor) {
      if (property === 'ELASTRAX_DB_PATH') {
        const value = descriptor.value as string | undefined;
        return Reflect.defineProperty(targetObject, property, { ...descriptor, value: value === undefined || value.trim() === '' ? fallbackPaths.dbPath : assertSafeDatabasePath(value) });
      }
      if (typeof property === 'string' && hasSafeDirectory(property)) {
        const value = descriptor.value as string | undefined;
        const fallback = safeDirectoryFallbacks[property];
        return Reflect.defineProperty(targetObject, property, { ...descriptor, value: value === undefined ? fallback : assertSafeMediaPath(value) });
      }
      return Reflect.defineProperty(targetObject, property, descriptor);
    },
    deleteProperty(targetObject, property) {
      if (property === 'ELASTRAX_DB_PATH') {
        targetObject.ELASTRAX_DB_PATH = fallbackPaths.dbPath;
        return true;
      }
      if (typeof property === 'string' && hasSafeDirectory(property)) {
        targetObject[property] = safeDirectoryFallbacks[property];
        return true;
      }
      return Reflect.deleteProperty(targetObject, property);
    },
    get(targetObject, property, receiver) {
      if (property === 'ELASTRAX_DB_PATH' && !targetObject.ELASTRAX_DB_PATH) ensureSafeDefaults(targetObject);
      if (typeof property === 'string' && hasSafeDirectory(property) && !targetObject[property]) ensureSafeDefaults(targetObject);
      if (property === 'FIXTURE_DUMP_DIR' && typeof targetObject.FIXTURE_DUMP_DIR === 'string' && isRepositoryDataPath(targetObject.FIXTURE_DUMP_DIR)) {
        throw new Error(`Refusing fixture path inside repository data: ${targetObject.FIXTURE_DUMP_DIR}`);
      }
      return Reflect.get(targetObject, property, receiver);
    },
    set(targetObject, property, value) {
      if (property === 'ELASTRAX_DB_PATH') {
        targetObject.ELASTRAX_DB_PATH = value === undefined || String(value).trim() === '' ? fallbackPaths.dbPath : assertSafeDatabasePath(String(value));
        return true;
      }
      if (typeof property === 'string' && hasSafeDirectory(property)) {
        const fallback = safeDirectoryFallbacks[property];
        targetObject[property] = value === undefined ? fallback : assertSafeMediaPath(String(value));
        return true;
      }
      if (property === 'FIXTURE_DUMP_DIR' && value !== undefined && isRepositoryDataPath(String(value))) {
        throw new Error(`Refusing fixture path inside repository data: ${String(value)}`);
      }
      return Reflect.set(targetObject, property, value);
    },
  });

  const installDescriptor = (value: unknown): void => {
    raw = unwrapEnvironment(value, proxy, raw);
    ensureSafeDefaults(raw);
    proxy = makeProxy(raw);
  };

  ensureSafeDefaults(raw);
  proxy = makeProxy(raw);
  Object.defineProperty(process, 'env', {
    configurable: true,
    enumerable: true,
    get: () => proxy,
    set: installDescriptor,
  });

  const restore = (): void => {
    if (!guardState) return;
    if (originalDescriptor) Object.defineProperty(process, 'env', originalDescriptor);
    else delete (process as unknown as { env?: NodeJS.ProcessEnv }).env;
    guardState = undefined;
  };
  guardState = { originalDescriptor, raw, proxy, restore };
  return restore;
}

export function assertHarnessEnvironment(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test environment was not configured.');
  if (process.env.ELASTRAX_TEST !== '1') throw new Error('Harness marker is missing.');
  assertSafeDatabasePath(process.env.ELASTRAX_DB_PATH);
  assertSafeMediaPath(process.env.ELASTRAX_MEDIA_DIR);
  assertSafeMediaPath(process.env.ELASTRAX_TEST_FIXTURES_DIR);
  assertSafeMediaPath(process.env.ELASTRAX_TEST_DOWNLOAD_DIR);
  assertSafeMediaPath(process.env.ELASTRAX_TEST_FFMPEG_DIR);
}
