import { logger } from './logger';

export abstract class BaseHttpClient {
  protected readonly baseUrl: string;
  protected readonly defaultHeaders: Record<string, string>;
  protected readonly log;
  protected readonly defaultTimeoutMs: number;

  constructor(
    baseUrl: string,
    defaultHeaders: Record<string, string> = {},
    moduleName: string = 'BaseHttpClient',
    defaultTimeoutMs = 30000
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.defaultHeaders = {
      'Accept': 'application/json',
      ...defaultHeaders,
    };
    this.log = logger.child({ module: moduleName });
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  get isConfigured(): boolean {
    return this.baseUrl !== '';
  }

  protected async request<T>(
    method: string, 
    path: string, 
    body?: unknown, 
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Invalid protocol for API URL: ${parsedUrl.protocol}. Must be http: or https:`);
    }

    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...extraHeaders,
    };

    if (body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    this.log.debug({ method, path }, 'API request');

    const resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.defaultTimeoutMs),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      this.log.error({ status: resp.status, path, text }, 'API error');
      throw new Error(`API ${method} ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
    }

    return resp.json() as Promise<T>;
  }

  protected get<T>(path: string, extraHeaders?: Record<string, string>): Promise<T> {
    return this.request<T>('GET', path, undefined, extraHeaders);
  }

  protected post<T>(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    return this.request<T>('POST', path, body, extraHeaders);
  }

  protected put<T>(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    return this.request<T>('PUT', path, body, extraHeaders);
  }

  protected delete<T>(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    return this.request<T>('DELETE', path, body, extraHeaders);
  }
}
