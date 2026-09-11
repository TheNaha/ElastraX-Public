/**
 * @file src/utils/withTimeout.ts
 * @description Shared timeout wrapper for promises.
 *
 * Races a promise against a timeout that rejects after a given number of
 * milliseconds, ensuring timers are cleaned up on both resolve and reject.
 *
 * Used by the agent loop, Scheduler, DigestService, and WebhookServer to
 * enforce send/receive deadlines without code duplication.
 */

/**
 * Wait for `promise` to settle, but reject if it takes longer than `timeoutMs`.
 *
 * @param promise   The promise to race against the timeout.
 * @param timeoutMs Timeout in milliseconds.
 * @param label     Optional label included in the timeout error message for
 *                  diagnostics. Defaults to `'operation'`.
 * @returns The resolved value of `promise` on success.
 * @throws  If the timeout fires or if `promise` rejects.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string = 'operation',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
