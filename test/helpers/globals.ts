import { getTestWorkerPaths, type TestWorkerPaths } from './paths';
import { snapshotEnvironment, restoreEnvironment, type EnvironmentSnapshot } from './env';
import { installFetchMock, type FetchImplementation, type FetchMock } from './fetch';
import { useFakeClock, type FakeClock } from './clock';
import { isolateTimers, type TimerIsolation } from './timers';

export interface IsolatedGlobalsOptions {
  env?: EnvironmentSnapshot;
  fetch?: FetchImplementation;
  now?: Date | number | string;
}

export interface IsolatedGlobals {
  paths: TestWorkerPaths;
  fetch: FetchMock;
  clock?: FakeClock;
  timers: TimerIsolation;
}

export async function withIsolatedGlobals<T>(
  callback: (globals: IsolatedGlobals) => T | Promise<T>,
  options: IsolatedGlobalsOptions = {},
): Promise<T> {
  const environment = snapshotEnvironment();
  const timers = isolateTimers();
  const fetchHandle = installFetchMock(options.fetch);
  const clock = options.now === undefined ? undefined : useFakeClock(options.now);
  try {
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    return await callback({ paths: getTestWorkerPaths(), fetch: fetchHandle.fetch, clock, timers });
  } finally {
    if (clock) clock.restore();
    fetchHandle.restore();
    timers.restore();
    restoreEnvironment(environment);
  }
}

export async function withIsolatedClock<T>(
  initial: Date | number | string,
  callback: (clock: FakeClock) => T | Promise<T>,
): Promise<T> {
  const clock = useFakeClock(initial);
  try {
    return await callback(clock);
  } finally {
    clock.restore();
  }
}
