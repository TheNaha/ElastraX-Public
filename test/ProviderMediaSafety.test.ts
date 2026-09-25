import { afterEach, describe, expect, mock, test } from 'bun:test';
import { get as httpGet } from 'node:http';
import {
  createLazyPromise,
  evaluateInlineMediaMetadata,
  HARD_MEDIA_MAX_BYTES,
  INLINE_MEDIA_MAX_BYTES,
  INLINE_MEDIA_MAX_PIXELS,
} from '../src/providers/media';
import { CancellableSemaphore } from '../src/providers/semaphore';
import { isPublicIp, SsrfSafeProxy, ssrfDeps, validateSsrfUrlWithLookup } from '../src/providers/ssrf';
import { chunkWhatsAppText } from '../src/providers/whatsapp';
import { activeProcessCount, minimalProcessEnv, runBoundedProcess } from '../src/providers/process';
import { withCancellableTimeout } from '../src/utils/withTimeout';

const originalLookup = ssrfDeps.lookup;

afterEach(() => {
  ssrfDeps.lookup = originalLookup;
});

describe('provider media safety helpers', () => {
  test('inline eligibility is limited to 10 MiB and 20 megapixels', () => {
    expect(evaluateInlineMediaMetadata({ sizeBytes: INLINE_MEDIA_MAX_BYTES, mimeType: 'image/png', width: 5000, height: 4000 })).toEqual({
      eligible: true,
      sizeBytes: INLINE_MEDIA_MAX_BYTES,
      mimeType: 'image/png',
      width: 5000,
      height: 4000,
      pixels: INLINE_MEDIA_MAX_PIXELS,
    });
    expect(evaluateInlineMediaMetadata({ sizeBytes: INLINE_MEDIA_MAX_BYTES + 1, mimeType: 'image/png', width: 100, height: 100 })).toMatchObject({ eligible: false, reason: 'too-large' });
    expect(evaluateInlineMediaMetadata({ sizeBytes: 100, mimeType: 'image/png', width: 5001, height: 4000 })).toMatchObject({ eligible: false, reason: 'dimensions-too-large' });
    expect(evaluateInlineMediaMetadata({ sizeBytes: 100, mimeType: 'audio/ogg', width: 100, height: 100 })).toMatchObject({ eligible: false, reason: 'not-image' });
  });

  test('lazy promises do not start acquisition until awaited', async () => {
    const operation = mock(async () => 42);
    const lazy = createLazyPromise(operation);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    const result = await lazy;
    expect(result).toBe(42);
    await lazy;
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('semaphore waiters are cancellable and release permits', async () => {
    const semaphore = new CancellableSemaphore(1);
    const first = semaphore.acquire();
    const controller = new AbortController();
    const cancelled = semaphore.acquire(1, controller.signal);
    controller.abort(new Error('cancel'));
    await expect(cancelled).rejects.toThrow('cancel');
    (await first)();
    const release = await semaphore.acquire();
    expect(semaphore.activePermits).toBe(1);
    release();
    expect(semaphore.activePermits).toBe(0);
  });

  test('SSRF validation rejects private, mixed, credential, and unusual-port targets', async () => {
    const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
    await expect(validateSsrfUrlWithLookup('https://example.com/video', publicLookup)).resolves.toMatchObject({ address: '93.184.216.34', family: 4 });
    await expect(validateSsrfUrlWithLookup('https://example.com/video', async () => [{ address: '10.0.0.1', family: 4 }])).rejects.toThrow('blocked network');
    await expect(validateSsrfUrlWithLookup('https://example.com/video', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])).rejects.toThrow('blocked network');
    await expect(validateSsrfUrlWithLookup('https://user:secret@example.com/video', publicLookup)).rejects.toThrow('Credential');
    await expect(validateSsrfUrlWithLookup('https://example.com:8080/video', publicLookup)).rejects.toThrow('port');
    expect(isPublicIp('169.254.169.254')).toBe(false);
    expect(isPublicIp('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicIp('fd00::1')).toBe(false);
  });

  test('the validating proxy rechecks each forwarded request', async () => {
    let lookupCount = 0;
    ssrfDeps.lookup = async () => {
      lookupCount++;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const proxy = await new SsrfSafeProxy().start();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpGet({ host: '127.0.0.1', port: proxy.port, path: 'http://example.com/video' }, response => {
          response.resume();
          response.once('end', () => resolve(response.statusCode || 0));
        });
        request.once('error', reject);
      });
      expect(status).toBe(403);
      expect(lookupCount).toBeGreaterThan(0);
    } finally {
      await proxy.close();
    }
  });

  test('WhatsApp chunking preserves Unicode code points', () => {
    const chunks = chunkWhatsAppText('😀'.repeat(3), 2);
    expect(chunks).toEqual(['😀😀', '😀']);
  });

  test('process environments omit unrelated secrets', () => {
    const env = minimalProcessEnv({ CUSTOM: 'yes' }, { PATH: '/bin', OPENAI_API_KEY: 'secret', DISCORD_BOT_TOKEN: 'secret' });
    expect(env).toEqual({ PATH: '/bin', CUSTOM: 'yes' });
  });

  test('process abort kills the process group and is reaped', async () => {
    // activeProcessCount is process-global, so compare against the count observed
    // before this test instead of assuming no other bounded process is running.
    const baseline = activeProcessCount();
    const controller = new AbortController();
    const running = runBoundedProcess({
      command: 'sh',
      args: ['-c', 'sleep 30'],
      kind: 'ffmpeg',
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('test abort')), 30);
    await expect(running).rejects.toMatchObject({ code: 'PROCESS_ABORTED' });
    expect(activeProcessCount()).toBeLessThanOrEqual(baseline);
  });

  test('cancellable timeout aborts its operation signal', async () => {
    let observed: AbortSignal | undefined;
    await expect(withCancellableTimeout(async signal => {
      observed = signal;
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }, 5, 'test')).rejects.toThrow('timed out');
    expect(observed?.aborted).toBe(true);
  });

  test('hard media cap remains exactly 200 MiB', () => {
    expect(HARD_MEDIA_MAX_BYTES).toBe(200 * 1024 * 1024);
  });
});
