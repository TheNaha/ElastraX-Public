type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeRawMessage(raw: unknown): string {
  if (!isRecord(raw)) return '{}';
  const key = isRecord(raw.key) ? raw.key : {};
  const message = isRecord(raw.message) ? raw.message : {};
  const safe = {
    id: typeof raw.id === 'string' || typeof raw.id === 'number' ? raw.id : null,
    fromMe: typeof key.fromMe === 'boolean' ? key.fromMe : null,
    timestamp: typeof message.timestamp === 'number' ? message.timestamp : null,
    attachmentCount: Array.isArray(raw.attachments) ? raw.attachments.length : 0,
  };
  return JSON.stringify(safe);
}
