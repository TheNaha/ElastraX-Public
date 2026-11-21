import { describe, expect, test } from 'bun:test';
import { withTimeout, withCancellableTimeout, abortable, TimeoutError } from '../src/utils/withTimeout';

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

describe('abortable', () => {
  test('rejects as soon as the signal aborts, without waiting for the work', async () => {
    const controller = new AbortController();
    // A promise that would resolve much later (or never): the abort must win.
    const work = sleep(10_000).then(() => 'late');
    const promise = abortable(work, controller.signal);
    controller.abort(new Error('stop now'));
    await expect(promise).rejects.toThrow('stop now');
  });

  test('resolves with the work result when it finishes before any abort', async () => {
    const controller = new AbortController();
    await expect(abortable(Promise.resolve('ok'), controller.signal)).resolves.toBe('ok');
  });

  test('rejects immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));
    await expect(abortable(sleep(1_000), controller.signal)).rejects.toThrow('pre-aborted');
  });

  test('swallows the underlying rejection after an abort so it is not unhandled', async () => {
    const controller = new AbortController();
    const work = new Promise<string>((_resolve, reject) => {
      setTimeout(() => reject(new Error('work failed late')), 10);
    });
    const promise = abortable(work, controller.signal);
    controller.abort(new Error('aborted first'));
    await expect(promise).rejects.toThrow('aborted first');
    // Give the work a tick to reject; the no-op handler attached by `abortable`
    // must prevent an unhandled-rejection crash.
    await sleep(30);
  });
});
