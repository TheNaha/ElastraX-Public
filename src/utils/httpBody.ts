/**
 * @file src/utils/httpBody.ts
 * @description Bounded read of a `fetch` Response body.
 *
 * `response.text()` / `arrayBuffer()` buffer the whole payload before any size
 * check can run, so a chunked response with no `Content-Length` is unbounded in
 * practice. Reading through a stream lets the cap be enforced as bytes arrive.
 *
 * Callers that need a specific error type (a provider error, an
 * `HttpClientError`) wrap the thrown `Error`.
 */

/** Default ceiling for a response this module reads. */
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Thrown when a body passes the byte ceiling. A distinct type so callers can map
 * it to their own diagnostic (e.g. `AIProtocolError('response_too_large')`)
 * without matching on the message text.
 */
export class ResponseBodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(label: string, maxBytes: number) {
    super(`${label} exceeds ${maxBytes} bytes.`);
    this.name = 'ResponseBodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/**
 * Read `response` as UTF-8, refusing more than `maxBytes`.
 *
 * @param label - used in the error message, e.g. "SearXNG response".
 */
export async function readResponseTextBounded(
  response: Response,
  maxBytes: number = DEFAULT_MAX_RESPONSE_BYTES,
  label = 'Response',
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('maxBytes must be a positive integer.');
  }
  const tooLarge = (): Error => new ResponseBodyTooLargeError(label, maxBytes);

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw tooLarge();
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    // The size branch already cancelled; cancel() is idempotent, and a reader
    // that errored on its own should not be cancelled twice.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total).toString('utf8');
}