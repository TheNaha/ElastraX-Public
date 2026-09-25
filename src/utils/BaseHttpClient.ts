import { logger } from './logger';

export interface HttpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class HttpClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly service: string;
  readonly method: string;
  readonly path: string;
  readonly retryable: boolean;

  constructor(
    service: string,
    method: string,
    path: string,
    code: string,
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'HttpClientError';
    this.code = code;
    this.status = options.status;
    this.service = service;
    this.method = method;
    this.path = path;
    this.retryable = options.retryable ?? false;
  }
}

export abstract class BaseHttpClient {
  protected readonly baseUrl: string;
  protected readonly defaultHeaders: Record<string, string>;
  protected readonly log;
  protected readonly defaultTimeoutMs: number;
  protected readonly maxResponseBytes: number;
  private readonly moduleName: string;

  constructor(
    baseUrl: string,
    defaultHeaders: Record<string, string> = {},
    moduleName = 'BaseHttpClient',
    defaultTimeoutMs = 30_000,
    maxResponseBytes = 10 * 1024 * 1024,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.moduleName = moduleName;
    this.defaultHeaders = {
      Accept: 'application/json',
      ...defaultHeaders,
    };
    this.log = logger.child({ module: moduleName });
    this.defaultTimeoutMs = normalizePositiveInteger(defaultTimeoutMs, 30_000);
    this.maxResponseBytes = normalizePositiveInteger(maxResponseBytes, 10 * 1024 * 1024);
  }

  get isConfigured(): boolean {
    return this.baseUrl !== '';
  }

  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    options: HttpRequestOptions = {},
  ): Promise<T> {
    const service = this.moduleName.replace(/Client$/, '');
    const url = `${this.baseUrl}${path}`;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      throw new HttpClientError(service, method, path, 'INVALID_URL', 'Invalid upstream URL.', { cause: error });
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new HttpClientError(service, method, path, 'INVALID_PROTOCOL', `Invalid upstream protocol: ${parsedUrl.protocol}`);
    }

    const headers: Record<string, string> = { ...this.defaultHeaders, ...extraHeaders };
    const serializedBody = serializeBody(body, headers);
    const controller = new AbortController();
    const timeoutMs = normalizePositiveInteger(options.timeoutMs ?? this.defaultTimeoutMs, this.defaultTimeoutMs);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new HttpClientError(service, method, path, 'TIMEOUT', `${service} request timed out after ${timeoutMs}ms.`, { retryable: true }));
    }, timeoutMs);
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    this.log.debug({ method, path }, 'API request');
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: serializedBody,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      if (error instanceof HttpClientError) throw error;
      if (timedOut) {
        throw new HttpClientError(service, method, path, 'TIMEOUT', `${service} request timed out after ${timeoutMs}ms.`, { retryable: true, cause: error });
      }
      throw new HttpClientError(service, method, path, 'NETWORK_ERROR', `${service} request failed: ${safeErrorMessage(error)}`, {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      const text = await readResponseText(response, this.maxResponseBytes, service, method, path).catch(() => '');
      const detail = sanitizeResponseText(text);
      this.log.error({ status: response.status, path }, 'API error');
      throw new HttpClientError(
        service,
        method,
        path,
        'HTTP_ERROR',
        `${service} API ${method} ${path} failed: ${response.status}${detail ? ` ${detail}` : ''}`,
        { status: response.status, retryable: response.status === 429 || response.status >= 500 },
      );
    }
    if (response.status === 204 || response.status === 205) return undefined as T;
    try {
      return await readJsonResponse<T>(response, this.maxResponseBytes, service, method, path);
    } catch (error) {
      if (error instanceof HttpClientError) throw error;
      throw new HttpClientError(service, method, path, 'INVALID_RESPONSE', `${service} returned invalid JSON: ${safeErrorMessage(error)}`, { cause: error });
    }
  }

  protected get<T>(path: string, extraHeaders?: Record<string, string>, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, extraHeaders, options);
  }

  protected post<T>(path: string, body?: unknown, extraHeaders?: Record<string, string>, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, extraHeaders, options);
  }

  protected put<T>(path: string, body?: unknown, extraHeaders?: Record<string, string>, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('PUT', path, body, extraHeaders, options);
  }

  protected delete<T>(path: string, body?: unknown, extraHeaders?: Record<string, string>, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, body, extraHeaders, options);
  }
}

function serializeBody(body: unknown, headers: Record<string, string>): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof FormData || body instanceof URLSearchParams || body instanceof Blob) return body;
  if (Buffer.isBuffer(body)) return body as unknown as BodyInit;
  if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return JSON.stringify(body);
}

async function readResponseText(response: Response, maxBytes: number, service: string, method: string, path: string): Promise<string> {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new HttpClientError(service, method, path, 'RESPONSE_TOO_LARGE', `Upstream response exceeds ${maxBytes} bytes.`);
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new HttpClientError(service, method, path, 'RESPONSE_TOO_LARGE', `Upstream response exceeds ${maxBytes} bytes.`);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!result.value) continue;
      total += result.value.byteLength;
      if (total > maxBytes) throw new HttpClientError(service, method, path, 'RESPONSE_TOO_LARGE', `Upstream response exceeds ${maxBytes} bytes.`);
      chunks.push(Buffer.from(result.value));
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function readJsonResponse<T>(response: Response, maxBytes: number, service = 'HTTP', method = 'GET', path = ''): Promise<T> {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new HttpClientError('HTTP', response.status ? 'GET' : 'GET', '', 'RESPONSE_TOO_LARGE', `Upstream response exceeds ${maxBytes} bytes.`);
    }
  }
  if (!response.body) return response.json() as Promise<T>;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) throw new HttpClientError(service, method, path, 'RESPONSE_TOO_LARGE', `Upstream response exceeds ${maxBytes} bytes.`);
        chunks.push(value);
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total).toString('utf8');
  return JSON.parse(body) as T;
}

function sanitizeResponseText(text: string): string {
  return stripControlCharacters(text).trim().slice(0, 200);
}

function safeErrorMessage(error: unknown): string {
  return stripControlCharacters(error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function stripControlCharacters(text: string): string {
  return Array.from(text, character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  }).join('');
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
