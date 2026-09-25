type TimerHandle = unknown;

export interface TimerIsolation {
  active(): number;
  restore(): void;
}

export function isolateTimers(): TimerIsolation {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const active = new Set<TimerHandle>();

  const setTimeoutWithTracking = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const handle = originalSetTimeout(handler, timeout, ...args) as unknown;
    active.add(handle);
    return handle;
  }) as unknown as typeof globalThis.setTimeout;
  const setIntervalWithTracking = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const handle = originalSetInterval(handler, timeout, ...args) as unknown;
    active.add(handle);
    return handle;
  }) as unknown as typeof globalThis.setInterval;
  const clearTimeoutWithTracking = ((handle?: TimerHandle) => {
    if (handle !== undefined) active.delete(handle);
    originalClearTimeout(handle as Parameters<typeof originalClearTimeout>[0]);
  }) as unknown as typeof globalThis.clearTimeout;
  const clearIntervalWithTracking = ((handle?: TimerHandle) => {
    if (handle !== undefined) active.delete(handle);
    originalClearInterval(handle as Parameters<typeof originalClearInterval>[0]);
  }) as unknown as typeof globalThis.clearInterval;

  globalThis.setTimeout = setTimeoutWithTracking;
  globalThis.setInterval = setIntervalWithTracking;
  globalThis.clearTimeout = clearTimeoutWithTracking;
  globalThis.clearInterval = clearIntervalWithTracking;

  return {
    active: () => active.size,
    restore() {
      for (const handle of active) {
        originalClearTimeout(handle as Parameters<typeof originalClearTimeout>[0]);
        originalClearInterval(handle as Parameters<typeof originalClearInterval>[0]);
      }
      active.clear();
      globalThis.setTimeout = originalSetTimeout;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearTimeout = originalClearTimeout;
      globalThis.clearInterval = originalClearInterval;
    },
  };
}

export async function withTrackedTimers<T>(callback: () => T | Promise<T>): Promise<T> {
  const isolation = isolateTimers();
  try {
    return await callback();
  } finally {
    isolation.restore();
  }
}
