import { jest } from 'bun:test';

export interface FakeClock {
  now(): number;
  set(value: Date | number | string): void;
  advance(milliseconds: number): void;
  runAllTimers(): void;
  restore(): void;
}

function toDate(value: Date | number | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid fake clock date: ${String(value)}`);
  return date;
}

export function useFakeClock(initial: Date | number | string = new Date()): FakeClock {
  const wasFake = jest.isFakeTimers();
  const previousNow = Date.now();
  let current = toDate(initial);
  jest.useFakeTimers({ now: current });

  const clock: FakeClock = {
    now: () => current.getTime(),
    set(value) {
      current = toDate(value);
      jest.setSystemTime(current);
    },
    advance(milliseconds) {
      if (!Number.isFinite(milliseconds)) throw new Error('Clock advancement must be finite.');
      current = new Date(current.getTime() + milliseconds);
      jest.advanceTimersByTime(milliseconds);
    },
    runAllTimers() {
      jest.runAllTimers();
    },
    restore() {
      if (wasFake) jest.useFakeTimers({ now: new Date(previousNow) });
      else jest.useRealTimers();
    },
  };
  return clock;
}

export const useTestClock = useFakeClock;

export async function withFakeClock<T>(
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

export async function withFakeTimers<T>(
  initial: Date | number | string,
  callback: (clock: FakeClock) => T | Promise<T>,
): Promise<T> {
  return withFakeClock(initial, callback);
}
