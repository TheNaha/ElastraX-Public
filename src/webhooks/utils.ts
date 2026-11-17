import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { WebhookBody } from './types';

export class WebhookRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'WebhookRequestError';
    this.status = status;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}



export function toObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record !== null) result.push(record);
  }
  return result;
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * String form of a scalar webhook field.
 *
 * Several plugins (notably Jellyfin's) serialise numeric fields such as `Year`
 * and `SeasonNumber00` as JSON numbers; reading them through
 * {@link asNonEmptyString} silently dropped every one of them.
 */
export function asScalarString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
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
    return value
      .split(/[;,]/)
      .map(part => part.trim())
      .filter(Boolean);
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

export function truncateText(text: string, maxLength: number): string {
  const boundedLength = Math.max(200, Math.trunc(maxLength));
  if (text.length <= boundedLength) return text;
  return `${text.slice(0, boundedLength - 1)}…`;
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
  return Number.isInteger(value) && value >= 0 && value <= 65_535;
}

export function resolveWebhookMaxBodyBytes(rawMaxBytes: string | undefined): number {
  const defaultBytes = 256 * 1024;
  if (rawMaxBytes === undefined || !/^\d+$/.test(rawMaxBytes)) return defaultBytes;
  const parsed = Number(rawMaxBytes);
  return Number.isSafeInteger(parsed) && parsed >= 1024 && parsed <= 10 * 1024 * 1024
    ? parsed
    : defaultBytes;
}

export async function readRequestBytesWithLimit(
  req: Request,
  maxBytes: number,
  timeoutMs = 5000,
): Promise<Uint8Array> {
  const contentLengthHeader = req.headers.get('content-length');
  if (contentLengthHeader !== null) {
    if (!/^\d+$/.test(contentLengthHeader)) {
      throw new WebhookRequestError(400, 'Invalid Content-Length header');
    }
    const declaredLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(declaredLength)) {
      throw new WebhookRequestError(400, 'Invalid Content-Length header');
    }
    if (declaredLength > maxBytes) {
      throw new WebhookRequestError(413, `Request body too large (${declaredLength} bytes). Limit is ${maxBytes} bytes.`);
    }
  }

  if (!req.body) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const readBody = async (): Promise<Uint8Array> => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;

        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          throw new WebhookRequestError(413, `Request body too large. Limit is ${maxBytes} bytes.`);
        }
        chunks.push(value);
      }
      const body = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return body;
    } finally {
      reader.releaseLock();
    }
  };

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel('timeout').catch(() => undefined);
      reject(new WebhookRequestError(408, `Request body read timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([readBody(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function readRequestBodyWithLimit(
  req: Request,
  maxBytes: number,
  timeoutMs = 5000,
): Promise<string> {
  const body = await readRequestBytesWithLimit(req, maxBytes, timeoutMs);
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

export function resolveWebhookPort(rawPort: string | undefined): number {
  if (rawPort === undefined || !/^\d+$/.test(rawPort)) return 3500;
  const parsed = Number(rawPort);
  return isValidPort(parsed) ? parsed : 3500;
}

export function resolveRoomIds(body: WebhookBody, url: URL): string[] {
  const directRoomId = asNonEmptyString(body.room_id);
  const queryRoomId = asNonEmptyString(url.searchParams.get('room_id'));
  const bodyRoomIds = toStringArray(body.room_ids);
  const queryRoomIds = toStringArray(url.searchParams.get('room_ids'));

  return uniqueStable([
    ...(directRoomId ? [directRoomId] : []),
    ...(queryRoomId ? [queryRoomId] : []),
    ...bodyRoomIds,
    ...queryRoomIds,
  ]);
}

export function validateDestinationIds(roomIds: string[], maxRoomIdLength: number): string[] {
  if (roomIds.length === 0) {
    throw new WebhookRequestError(400, 'Missing room_id');
  }
  for (const roomId of roomIds) {
    if (roomId.length > maxRoomIdLength || !/^[A-Za-z0-9@._:-]+$/.test(roomId)) {
      throw new WebhookRequestError(400, 'Invalid room_id');
    }
  }
  return roomIds;
}

export function validateSource(source: string, maxLength: number): string {
  if (source.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(source)) {
    throw new WebhookRequestError(400, 'Invalid webhook source');
  }
  return source;
}

export function validateReplayId(value: string): string {
  if (value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new WebhookRequestError(400, 'Invalid webhook replay ID');
  }
  return value;
}

export function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

const SENSITIVE_KEY = /(?:secret|token|password|passphrase|authorization|cookie|api[-_]?key|private[-_]?key|credential)/i;

export function sanitizeWebhookBody(value: WebhookBody): WebhookBody {
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > 32) return '[TRUNCATED]';
    if (Array.isArray(input)) return input.map(item => visit(item, depth + 1));
    const record = asRecord(input);
    if (record === null) return input;

    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      if (SENSITIVE_KEY.test(key.replace(/[-\s]/g, '_'))) continue;
      sanitized[key] = visit(nested, depth + 1);
    }
    return sanitized;
  };

  return visit(value, 0) as WebhookBody;
}

export function verifyGitHubSignature(
  payload: string | Uint8Array,
  secret: string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader || !/^sha256=[0-9a-f]{64}$/i.test(signatureHeader)) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  return safeSecretCompare(signatureHeader.toLowerCase(), expected);
}

export function safeSecretCompare(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

type RateBucket = {
  tokens: number;
  updatedAt: number;
};

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export class WebhookRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly maxSources: number,
  ) {}

  consume(keys: string[], now: number): RateLimitResult {
    const uniqueKeys = [...new Set(keys)];

    // A request is refused for capacity only when it is *entirely* unknown and
    // the map is full. Refusing because a sibling key would have to be added let
    // an unseen peer address (a NAT rebind, a proxy hop change, `unknown`) lock a
    // long-lived sender out even though its own bucket was full — the inverse of
    // the invariant this guard is meant to protect. Keys that cannot be tracked
    // without exceeding the cap are simply not stored: the request is decided by
    // the keys that are known, and the map never grows past `maxSources`.
    const unseen = uniqueKeys.filter(key => !this.buckets.has(key));
    let hasCapacity = this.buckets.size + unseen.length <= this.maxSources;
    if (!hasCapacity) {
      // Reclaim expired buckets *before* refusing. Pruning used to be gated on
      // `size >= maxSources`, so a map that sat one below the cap (99/100) never
      // pruned again and refused every brand-new sender forever — a permanent
      // lockout, not a rate limit. Pruning is O(map) and only runs when the
      // request actually needs room, which is rare.
      this.prune(now);
      hasCapacity = this.buckets.size + unseen.length <= this.maxSources;
    }
    if (!hasCapacity && unseen.length === uniqueKeys.length) {
      // Nothing is tracked, so nothing becomes eligible until `prune` can drop an
      // entry — which happens after two windows, not one.
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((this.windowMs * 2) / 1000)) };
    }

    let retryAfterMs = 0;
    for (const key of uniqueKeys) {
      const existing = this.buckets.get(key);
      if (!existing && !hasCapacity) continue;
      const bucket = existing ?? { tokens: this.maxRequests, updatedAt: now };
      const elapsed = Math.max(0, now - bucket.updatedAt);
      const tokens = Math.min(this.maxRequests, bucket.tokens + (elapsed * this.maxRequests) / this.windowMs);
      if (tokens < 1) {
        retryAfterMs = Math.max(retryAfterMs, Math.ceil(((1 - tokens) * this.windowMs) / this.maxRequests));
      }
      this.buckets.set(key, { tokens, updatedAt: now });
    }

    if (retryAfterMs > 0) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    for (const key of uniqueKeys) {
      const bucket = this.buckets.get(key);
      if (bucket) bucket.tokens -= 1;
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drop buckets whose window has long expired. Callers decide when to pay for the scan. */
  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= this.windowMs * 2) this.buckets.delete(key);
    }
  }

  /** Number of tracked buckets. Bounded by `maxSources`. */
  get size(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
  }
}

/** `in_flight` = the same id is being processed right now, not already delivered. */
export type ReplayReservation = 'reserved' | 'duplicate' | 'in_flight' | 'capacity';

export class WebhookReplayCache {
  private readonly completed = new Map<string, number>();
  private readonly pending = new Set<string>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  reserve(key: string, now: number): ReplayReservation {
    this.prune(now);
    const completedAt = this.completed.get(key);
    if (completedAt !== undefined && completedAt > now) return 'duplicate';
    if (completedAt !== undefined) this.completed.delete(key);
    // A pending key is *in progress*, not delivered. Reporting it as a duplicate
    // acked the retry with `ok`; if the first request then failed and released
    // its reservation, the sender never retried and the event was lost.
    if (this.pending.has(key)) return 'in_flight';
    if (this.completed.size + this.pending.size >= this.maxEntries) return 'capacity';
    this.pending.add(key);
    return 'reserved';
  }

  complete(key: string, now: number): void {
    if (!this.pending.delete(key)) return;
    this.completed.set(key, now + this.ttlMs);
  }

  release(key: string): void {
    this.pending.delete(key);
  }

  clear(): void {
    this.completed.clear();
    this.pending.clear();
  }

  /**
   * Drop expired entries.
   *
   * `reserve()` calls this on every request, so the scan has to stay off the hot
   * path: the rate limiter next door guards its identical loop with
   * `if (this.buckets.size < this.maxSources) return;`, and this one did not, so
   * every webhook request walked the whole cache (measured at 257 µs/request once
   * a 10 000-entry default cache was full — linear in cache size, on the one path
   * that must be cheap). Eviction also only *needs* to happen at capacity, since
   * an expired entry is otherwise treated as absent by `reserve()`.
   */
  private prune(now: number): void {
    if (this.completed.size + this.pending.size < this.maxEntries) return;
    for (const [key, expiresAt] of this.completed) {
      if (expiresAt <= now) this.completed.delete(key);
    }
  }
}
