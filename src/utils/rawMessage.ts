type UnknownRecord = Record<string, unknown>;

/** Sensitive blob / key fields to strip before persisting raw messages to the DB. */
const RAW_MESSAGE_BLOB_KEYS = new Set([
  'jpegThumbnail', 'firstFrameSidecar', 'mediaKey', 'fileSha256',
  'fileEncSha256', 'scansSidecar', 'midQualityFileSha256', 'messageSecret',
  'senderKeyHash', 'recipientKeyHash', 'deviceListMetadata',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strip sensitive blob/key fields from a raw provider message while preserving
 * the full structure (including `key` and `message`) so downstream consumers
 * — ParserCoverage, extractStoredMessage, syncHistoricalDatabase — can still
 * identify message types, media info, and quoted messages.
 *
 * Recursively strips BLOB_KEYS at any nesting depth.
 */
function stripBlobs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBlobs);
  if (!isRecord(value)) return value;
  const out: UnknownRecord = {};
  for (const [key, val] of Object.entries(value)) {
    if (RAW_MESSAGE_BLOB_KEYS.has(key)) continue;
    out[key] = stripBlobs(val);
  }
  return out;
}

export function sanitizeRawMessage(raw: unknown): string {
  if (!isRecord(raw)) return '{}';
  return JSON.stringify(stripBlobs(raw));
}
