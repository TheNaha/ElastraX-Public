export type PermitSignal = AbortSignal | undefined;

type Waiter = {
  permits: number;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class CancellableSemaphore {
  private available: number;
  private used = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error('Semaphore capacity must be a positive safe integer.');
    }
    this.available = capacity;
  }

  get activePermits(): number {
    return this.used;
  }

  get pending(): number {
    return this.waiters.length;
  }

  tryAcquire(permits = 1): (() => void) | null {
    if (!this.isValidPermitCount(permits) || permits > this.available) return null;
    this.available -= permits;
    this.used += permits;
    return () => this.release(permits);
  }

  async acquire(permits = 1, signal?: PermitSignal): Promise<() => void> {
    const immediate = this.tryAcquire(permits);
    if (immediate) return immediate;
    if (!this.isValidPermitCount(permits)) {
      throw new Error('Semaphore permit count must be a positive safe integer.');
    }
    if (permits > this.capacity) {
      // `tryAcquire` returns null for this case too, so without the explicit
      // check the request was queued forever: `drain` can never satisfy a waiter
      // that asks for more permits than the semaphore has.
      throw new Error('Semaphore permit count exceeds capacity.');
    }
    if (signal?.aborted) throw abortError(signal);

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { permits, resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError(signal));
          // Removing a waiter can unblock the ones behind it: `drain` is FIFO by
          // permits, so a removed head waiter must hand its turn on. Without this
          // a small request queued behind an aborted reservation waited for an
          // unrelated release.
          this.drain();
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  async withPermit<T>(operation: () => Promise<T> | T, signal?: PermitSignal, permits = 1): Promise<T> {
    const release = await this.acquire(permits, signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  release(permits = 1): void {
    if (!this.isValidPermitCount(permits) || permits > this.used) {
      throw new Error('Semaphore release exceeds acquired permits.');
    }
    this.used -= permits;
    this.available += permits;
    this.drain();
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (waiter.permits > this.available) break;
      this.waiters.shift();
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      this.available -= waiter.permits;
      this.used += waiter.permits;
      const permits = waiter.permits;
      waiter.resolve(() => this.release(permits));
    }
  }

  private isValidPermitCount(permits: number): boolean {
    return Number.isSafeInteger(permits) && permits > 0;
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Semaphore acquisition aborted.');
  error.name = 'AbortError';
  return error;
}
