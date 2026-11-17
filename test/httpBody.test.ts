import { describe, test, expect } from 'bun:test';
import { readResponseTextBounded } from '../src/utils/httpBody';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('readResponseTextBounded', () => {
  test('reads a body within the limit', async () => {
    const response = new Response(streamOf('hello ', 'world'));
    expect(await readResponseTextBounded(response, 100)).toBe('hello world');
  });

  test('rejects a chunked body over the limit', async () => {
    const response = new Response(streamOf('a'.repeat(64), 'b'.repeat(64)));
    await expect(readResponseTextBounded(response, 100)).rejects.toThrow(/exceeds 100 bytes/);
  });

  test('rejects a declared content-length over the limit before reading', async () => {
    const response = new Response('x', { headers: { 'content-length': '1000' } });
    await expect(readResponseTextBounded(response, 10)).rejects.toThrow(/exceeds 10 bytes/);
  });

  test('accepts a body exactly at the limit', async () => {
    const response = new Response('abcde');
    expect(await readResponseTextBounded(response, 5)).toBe('abcde');
  });

  test('handles an empty body', async () => {
    expect(await readResponseTextBounded(new Response(''), 10)).toBe('');
  });

  test('rejects a non-positive limit', async () => {
    await expect(readResponseTextBounded(new Response('x'), 0)).rejects.toThrow(/positive integer/);
  });
});