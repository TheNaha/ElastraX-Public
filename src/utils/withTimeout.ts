export class TimeoutError extends Error {
  readonly code = 'TIMEOUT';

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * An abort signal that fires after `ms`.
 *
 * Named `timeoutSignal` so it is not confused with {@link withTimeout}, which
 * races a promise. Three call sites had hand-rolled this with a fallback timer
 * that was never cleared and never `unref`'d, so each request left a timer
 * holding its closure until the timeout elapsed even after the fetch finished.
 */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return controller.signal;
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
      // Settle before running the callbacks. `abort()` invokes every listener
      // synchronously, so a listener (or an `onTimeout` handler) that throws
      // used to prevent `fail` from ever running and left this promise pending
      // forever while the caller awaited it.
      fail(error);
      try {
        options.onTimeout?.(error);
      } catch {
        // A throwing timeout hook must not affect the outcome that is already
        // decided.
      }
      try {
        options.abortController?.abort(error);
      } catch {
        // Same: the operation is aborting; a throwing listener is its problem.
      }
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
