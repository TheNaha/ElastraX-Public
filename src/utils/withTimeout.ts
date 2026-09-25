export class TimeoutError extends Error {
  readonly code = 'TIMEOUT';

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

export interface WithTimeoutOptions {
  signal?: AbortSignal;
  abortController?: AbortController;
  onTimeout?: (error: TimeoutError) => void;
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label = 'operation',
  options: WithTimeoutOptions = {},
): Promise<T> {
  return raceWithTimeout(Promise.resolve(promise), timeoutMs, label, options);
}

export async function withCancellableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label = 'operation',
  signal?: AbortSignal,
): Promise<T> {
  validateTimeout(timeoutMs);
  if (signal?.aborted) throw abortReason(signal);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    return await raceWithTimeout(
      Promise.resolve().then(() => operation(controller.signal)),
      timeoutMs,
      label,
      {
        signal,
        abortController: controller,
        onTimeout: error => controller.abort(error),
      },
    );
  } finally {
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  options: WithTimeoutOptions,
): Promise<T> {
  validateTimeout(timeoutMs);
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const fail = (error: unknown) => finish(() => reject(error));
    const onAbort = () => fail(abortReason(options.signal!));
    const timer = setTimeout(() => {
      const error = new TimeoutError(label, timeoutMs);
      options.onTimeout?.(error);
      options.abortController?.abort(error);
      fail(error);
    }, timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => finish(() => resolve(value)),
      error => fail(error),
    );
  });
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Timeout must be a positive safe integer.');
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Operation aborted.');
}
