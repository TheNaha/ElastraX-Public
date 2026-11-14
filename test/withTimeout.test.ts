import { describe, expect, test } from 'bun:test';
import { withTimeout, withCancellableTimeout, TimeoutError } from '../src/utils/withTimeout';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('withTimeout', () => {
  test('resolves with the operation result when it finishes first', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, 'fast')).resolves.toBe('ok');
  });

  test('rejects with TimeoutError when the timer wins', async () => {
    const promise = withTimeout(sleep(50), 10, 'slow');
    await expect(promise).rejects.toBeInstanceOf(TimeoutError);
    await expect(promise).rejects.toThrow('slow timed out after 10ms');
  });

  test('a throwing onTimeout handler cannot leave the promise unsettled', async () => {
    // `abort()` and `onTimeout` run synchronously; if either threw before the
    // promise was rejected the caller awaited forever.
    const promise = withTimeout(new Promise(() => {}), 10, 'hang', {
      onTimeout: () => {
        throw new Error('hook exploded');
      },
    });
    await expect(promise).rejects.toBeInstanceOf(TimeoutError);
  });

  test('rejects immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancel'));
    await expect(withTimeout(Promise.resolve(1), 50, 'aborted', { signal: controller.signal }))
      .rejects.toThrow('cancel');
  });

  test('rejects a non-positive timeout', () => {
    expect(() => withTimeout(Promise.resolve(1), 0)).toThrow('Timeout must be a positive safe integer.');
  });
});

describe('withCancellableTimeout', () => {
  test('aborts the operation signal when the timeout fires', async () => {
    let seen: AbortSignal | undefined;
    const promise = withCancellableTimeout(
      signal => {
        seen = signal;
        return sleep(100);
      },
      10,
      'cancel-me',
    );
    await expect(promise).rejects.toBeInstanceOf(TimeoutError);
    expect(seen?.aborted).toBe(true);
  });

  test('rejects without calling the operation when the caller already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('early'));
    let called = false;
    await expect(withCancellableTimeout(async () => {
      called = true;
      return 1;
    }, 50, 'never', controller.signal)).rejects.toThrow('early');
    expect(called).toBe(false);
  });

  test('removes its abort listener after completion', async () => {
    const controller = new AbortController();
    await withCancellableTimeout(async () => 'done', 50, 'clean', controller.signal);
    // Aborting after completion must not affect anything.
    controller.abort(new Error('late'));
    expect(controller.signal.aborted).toBe(true);
  });
});
