import { createHmac, timingSafeEqual } from 'crypto';
import { getWebhookMaxTextLength } from '../config/runtime';
import type { WebhookBody } from './types';

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asWebhookBody(value: unknown): WebhookBody {
  return asRecord(value) ?? {};
}

export function toObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record !== null) {
      result.push(record);
    }
  }
  return result;
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    const result: string[] = [];
    for (const item of value) {
      const trimmed = typeof item === 'string' ? item.trim() : String(item ?? '').trim();
      if (trimmed) result.push(trimmed);
    }
    return result;
  }

  if (typeof value === 'string') {
    const result: string[] = [];
    for (const part of value.split(/[;,]/)) {
      const trimmed = part.trim();
      if (trimmed) result.push(trimmed);
    }
    return result;
  }

  return [];
}

export function uniqueStable(values: string[]): string[] {
  return [...new Set(values)];
}

export function normalizePriority(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === 'critical' || normalized === 'emergency') return 'critical';
  if (normalized === 'high' || normalized === 'warning' || normalized === 'warn') return 'high';
  if (normalized === 'low' || normalized === 'debug') return 'low';
  return 'normal';
}

export function truncateText(text: string): string {
  const maxLength = Math.max(200, getWebhookMaxTextLength());
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

export function mergeBindings<T extends { id: number }>(...bindingGroups: T[][]): T[] {
  const merged: T[] = [];
  const seen = new Set<number>();

  for (const group of bindingGroups) {
    for (const binding of group) {
      if (seen.has(binding.id)) continue;
      seen.add(binding.id);
      merged.push(binding);
    }
  }

  return merged;
}

export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

export function resolveWebhookMaxBodyBytes(rawMaxBytes: string | undefined): number {
  const defaultBytes = 256 * 1024;
  const parsed = Number.parseInt((rawMaxBytes ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultBytes;
}

export async function readRequestBodyWithLimit(req: Request, maxBytes: number): Promise<string> {
  const contentLengthHeader = req.headers.get('content-length');
  const declaredLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : Number.NaN;
  if (Number.isInteger(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Request body too large (${declaredLength} bytes). Limit is ${maxBytes} bytes.`);
  }

  if (!req.body) return '';

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let bodyText = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`Request body too large (${totalBytes} bytes). Limit is ${maxBytes} bytes.`);
      }

      bodyText += decoder.decode(value, { stream: true });
    }

    bodyText += decoder.decode();
    return bodyText;
  } finally {
    reader.releaseLock();
  }
}

export function resolveWebhookPort(rawPort: string | undefined): number {
  const defaultPort = 3500;
  const parsed = Number.parseInt((rawPort ?? '').trim(), 10);
  return isValidPort(parsed) ? parsed : defaultPort;
}

export function resolveRoomIds(body: WebhookBody, url: URL): string[] {
  const directRoomId = asNonEmptyString(body.room_id);
  const queryRoomId = asNonEmptyString(url.searchParams.get('room_id'));
  const bodyRoomIds = toStringArray(body.room_ids);
  const queryRoomIds = toStringArray(url.searchParams.get('room_ids'));

  const allRoomIds = [
    ...(directRoomId ? [directRoomId] : []),
    ...(queryRoomId ? [queryRoomId] : []),
    ...bodyRoomIds,
    ...queryRoomIds,
  ];

  return uniqueStable(allRoomIds);
}

export function verifyGitHubSignature(payload: string, secret: string, signatureHeader: string | null): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signatureHeader);

  if (expectedBuf.length !== providedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

export function safeSecretCompare(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
