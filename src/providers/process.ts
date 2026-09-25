import { spawn as nodeSpawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CancellableSemaphore } from './semaphore';

const PROCESS_SEMAPHORES = {
  ffmpeg: new CancellableSemaphore(2),
  ffprobe: new CancellableSemaphore(2),
  'yt-dlp': new CancellableSemaphore(1),
} as const;

const activeProcesses = new Set<ChildProcess>();
const DEFAULT_PROCESS_OUTPUT_LIMIT = 200 * 1024 * 1024;
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

export class ProcessExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'ProcessExecutionError';
    this.code = code;
  }
}

export interface BoundedProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  kind: keyof typeof PROCESS_SEMAPHORES;
  timeoutMs: number;
  signal?: AbortSignal;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  input?: Uint8Array;
  env?: Record<string, string | undefined>;
  spawn?: typeof nodeSpawn;
  watchDirectory?: { path: string; maxBytes: number };
}

export interface BoundedProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTruncated: boolean;
}

export const processRunnerDeps = {
  spawn: nodeSpawn,
};

export function minimalProcessEnv(
  extra: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: source.PATH || '/usr/local/bin:/usr/bin:/bin',
  };
  for (const key of ENV_ALLOWLIST) {
    if (key !== 'PATH' && source[key]) env[key] = source[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export async function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  throwIfAborted(options.signal);
  const release = await PROCESS_SEMAPHORES[options.kind].acquire(1, options.signal);
  try {
    throwIfAborted(options.signal);
    return await runWithPermit(options);
  } finally {
    release();
  }
}

export function activeProcessCount(): number {
  return activeProcesses.size;
}

export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  const pid = child.pid;
  if (!pid) return false;
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, signal);
    } else {
      child.kill(signal);
    }
    return true;
  } catch {
    try {
      child.kill(signal);
      return child.killed;
    } catch {
      return false;
    }
  }
}

export function cancelActiveProcesses(signal: NodeJS.Signals = 'SIGTERM'): number {
  let count = 0;
  for (const child of activeProcesses) {
    if (killProcessGroup(child, signal)) count++;
  }
  return count;
}

async function runWithPermit(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const stdoutLimit = normalizeLimit(options.stdoutLimitBytes, 1024 * 1024);
  const stderrLimit = normalizeLimit(options.stderrLimitBytes, 64 * 1024);
  const controller = new AbortController();
  let abortKind: 'caller' | 'timeout' | null = null;
  let spawnError: Error | null = null;
  let terminationError: ProcessExecutionError | null = null;
  let stderrTruncated = false;
  let settled = false;

  return await new Promise<BoundedProcessResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let watchTimer: ReturnType<typeof setInterval> | undefined;
    let watchingDirectory = false;
    let externalAbortListener: (() => void) | undefined;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (watchTimer) clearInterval(watchTimer);
      controller.signal.removeEventListener('abort', abortListener);
      options.signal?.removeEventListener('abort', externalAbortListener!);
      activeProcesses.delete(child);
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = (result: BoundedProcessResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const terminate = (error: ProcessExecutionError) => {
      if (terminationError) return;
      terminationError = error;
      killProcessGroup(child, 'SIGTERM');
      activeProcesses.delete(child);
      killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 2000);
      killTimer.unref?.();
    };

    function abortListener() {
      const message = abortKind === 'timeout'
        ? `Process timed out after ${timeoutMs}ms.`
        : 'Process aborted.';
      terminate(new ProcessExecutionError(abortKind === 'timeout' ? 'PROCESS_TIMEOUT' : 'PROCESS_ABORTED', message, { cause: options.signal?.reason }));
    }

    try {
      const spawnOptions: SpawnOptions = {
        cwd: options.cwd,
        env: minimalProcessEnv(options.env),
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      };
      child = (options.spawn ?? processRunnerDeps.spawn)(options.command, options.args, spawnOptions) as ChildProcessWithoutNullStreams;
    } catch (error) {
      settled = true;
      reject(error);
      return;
    }

    activeProcesses.add(child);
    controller.signal.addEventListener('abort', abortListener, { once: true });
    if (options.signal) {
      externalAbortListener = () => {
        abortKind = 'caller';
        controller.abort(options.signal?.reason);
      };
      options.signal.addEventListener('abort', externalAbortListener, { once: true });
      if (options.signal.aborted) externalAbortListener();
    }
    const timeoutTimer = setTimeout(() => {
      abortKind = 'timeout';
      controller.abort(new ProcessExecutionError('PROCESS_TIMEOUT', `Process timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.stdout.on('data', (chunk: Buffer | string) => {
      const data = toBuffer(chunk);
      const remaining = stdoutLimit - stdout.length;
      if (remaining > 0) stdout = Buffer.concat([stdout, data.subarray(0, remaining)]);
      if (data.length > remaining) {
        terminate(new ProcessExecutionError('PROCESS_OUTPUT_LIMIT', `Process stdout exceeded ${stdoutLimit} bytes.`));
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const data = toBuffer(chunk);
      const remaining = stderrLimit - stderr.length;
      if (remaining > 0) stderr = Buffer.concat([stderr, data.subarray(0, remaining)]);
      if (data.length > remaining) stderrTruncated = true;
    });

    child.on('error', (error) => {
      spawnError = error;
      if (!child.pid) {
        rejectOnce(new ProcessExecutionError('PROCESS_SPAWN_FAILED', `Failed to start ${options.command}: ${error.message}`, { cause: error }));
      }
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      if (terminationError) {
        rejectOnce(terminationError);
        return;
      }
      if (spawnError) {
        rejectOnce(new ProcessExecutionError('PROCESS_SPAWN_FAILED', `Process failed: ${spawnError.message}`, { cause: spawnError }));
        return;
      }
      if (code !== 0) {
        const detail = stderr.toString('utf8').trim();
        rejectOnce(new ProcessExecutionError('PROCESS_EXIT_FAILED', `${options.command} exited with ${code ?? signal ?? 'unknown'}${detail ? `: ${detail}` : '.'}`));
        return;
      }
      resolveOnce({ stdout, stderr, code, signal, stderrTruncated });
    });

    child.stdin.on('error', () => undefined);
    if (child.stdin && !child.stdin.destroyed) {
      if (options.input) child.stdin.end(options.input);
      else child.stdin.end();
    }

    if (options.watchDirectory) {
      const maxBytes = normalizeLimit(options.watchDirectory.maxBytes, DEFAULT_PROCESS_OUTPUT_LIMIT);
      const checkDirectory = async () => {
        if (settled || watchingDirectory) return;
        watchingDirectory = true;
        try {
          let total = 0;
          const names = await readdir(options.watchDirectory!.path);
          for (const name of names) {
            const info = await stat(join(options.watchDirectory!.path, name)).catch(() => null);
            if (!info?.isFile()) continue;
            total += info.size;
            if (total > maxBytes) {
              terminate(new ProcessExecutionError('PROCESS_OUTPUT_LIMIT', `Process output files exceeded ${maxBytes} bytes.`));
              break;
            }
          }
        } catch {
          return;
        } finally {
          watchingDirectory = false;
        }
      };
      watchTimer = setInterval(() => void checkDirectory(), 250);
      watchTimer.unref?.();
      void checkDirectory();
    }
  });
}

function toBuffer(value: Buffer | string): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new ProcessExecutionError('PROCESS_ABORTED', 'Process aborted.', { cause: signal.reason });
  throw error;
}

function normalizeTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Process timeout must be a positive safe integer.');
  return value;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new Error('Process output limit must be a non-negative safe integer.');
  return resolved;
}
