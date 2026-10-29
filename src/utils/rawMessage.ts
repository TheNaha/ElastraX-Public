import { isPlainObject } from './typeGuards';

type UnknownRecord = Record<string, unknown>;

/** Sensitive blob / key fields to strip before persisting raw messages to the DB. */
export const RAW_MESSAGE_BLOB_KEYS = new Set([
  'jpegThumbnail', 'firstFrameSidecar', 'mediaKey', 'fileSha256',
  'fileEncSha256', 'scansSidecar', 'midQualityFileSha256', 'messageSecret',
  'senderKeyHash', 'recipientKeyHash', 'deviceListMetadata',
]);

/**
 * Strip sensitive blob/key fields from a raw provider message while preserving
 * the full structure (including `key` and `message`) so downstream consumers
 * — ParserCoverage, extractStoredMessage, syncHistoricalDatabase — can still
 * identify message types, media info, and quoted messages.
 *
 * Recursively strips BLOB_KEYS at any nesting depth.
 *
 * Canonical implementation — all other copies of `stripBlobs` should import
 * from this module to avoid drift.
 */
export function stripBlobs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBlobs);
  if (!isPlainObject(value)) return value;
  const out: UnknownRecord = {};
  for (const [key, val] of Object.entries(value)) {
    if (RAW_MESSAGE_BLOB_KEYS.has(key)) continue;
    out[key] = stripBlobs(val);
  }
  return out;
}

export function sanitizeRawMessage(raw: unknown): string {
  if (!isPlainObject(raw)) return '{}';
  return JSON.stringify(stripBlobs(raw));
}
