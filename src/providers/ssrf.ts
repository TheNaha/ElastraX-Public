import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.arpa'];
const ALLOWED_PORTS = new Set([80, 443]);
const DNS_LOOKUP_TIMEOUT_MS = 5_000;

export class SsrfPolicyError extends Error {
  readonly code = 'SSRF_BLOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'SsrfPolicyError';
  }
}

export interface SafeNetworkTarget {
  url: URL;
  hostname: string;
  port: number;
  addresses: LookupAddress[];
  address: string;
  family: number;
}

export const ssrfDeps = {
  lookup: async (hostname: string): Promise<LookupAddress[]> => dnsLookup(hostname, { all: true, verbatim: true }),
};

export async function validateSsrfUrl(input: string | URL): Promise<SafeNetworkTarget> {
  return validateSsrfUrlWithLookup(input, ssrfDeps.lookup);
}

export async function validateSsrfUrlWithLookup(
  input: string | URL,
  lookup: (hostname: string) => Promise<LookupAddress[]>,
): Promise<SafeNetworkTarget> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch {
    throw new SsrfPolicyError('Invalid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfPolicyError('Only HTTP and HTTPS URLs are allowed.');
  }
  if (url.username || url.password) throw new SsrfPolicyError('Credential-bearing URLs are not allowed.');
  const hostname = normalizeHostname(url.hostname);
  if (!hostname || net.isIP(hostname) === 0 && isBlockedHostname(hostname)) {
    throw new SsrfPolicyError(`Blocked hostname: ${hostname || 'empty'}.`);
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) throw new SsrfPolicyError(`Blocked destination port: ${port}.`);
  let addresses: LookupAddress[];
  try {
    addresses = await withDnsTimeout(lookup(hostname));
  } catch {
    throw new SsrfPolicyError(`Unable to resolve hostname: ${hostname}.`);
  }
  if (addresses.length === 0 || addresses.some(entry => !isPublicIp(entry.address))) {
    throw new SsrfPolicyError(`Hostname resolves to a blocked network: ${hostname}.`);
  }
  const selected = addresses[0];
  return { url, hostname, port, addresses, address: selected.address, family: selected.family };
}

export function isPublicIp(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase().split('%', 1)[0];
  const version = net.isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

async function withDnsTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SsrfPolicyError('DNS lookup timed out.')), DNS_LOOKUP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SsrfSafeProxy {
  private server: http.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private listeningPort = 0;

  get port(): number {
    return this.listeningPort;
  }

  get url(): string {
    if (!this.listeningPort) throw new Error('SSRF proxy is not started.');
    return `http://127.0.0.1:${this.listeningPort}`;
  }

  async start(): Promise<this> {
    if (this.server) return this;
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.on('connect', (request, socket, head) => {
      void this.handleConnect(request, socket as net.Socket, head);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to determine SSRF proxy port.'));
          return;
        }
        this.listeningPort = address.port;
        resolve();
      });
    });
    return this;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listeningPort = 0;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!server) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let target: SafeNetworkTarget;
    try {
      target = await validateSsrfUrl(request.url || '');
    } catch {
      response.writeHead(403, { 'Content-Type': 'text/plain' });
      response.end('Blocked destination');
      return;
    }
    const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: target.url.host };
    delete headers['proxy-connection'];
    const lookup = pinnedLookup(target);
    const requestFactory = target.url.protocol === 'https:' ? https.request : http.request;
    const upstream = requestFactory(target.url, {
      method: request.method,
      headers,
      lookup,
      family: target.family,
    }, upstreamResponse => {
      if (upstreamResponse.socket) this.trackSocket(upstreamResponse.socket);
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('socket', socket => this.trackSocket(socket));
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain' });
      response.end('Upstream connection failed');
    });
    request.pipe(upstream);
  }

  private async handleConnect(request: IncomingMessage, clientSocket: net.Socket, head: Buffer): Promise<void> {
    const rawTarget = request.url || '';
    const separator = rawTarget.lastIndexOf(':');
    const host = separator > 0 ? rawTarget.slice(0, separator) : rawTarget;
    const rawPort = separator > 0 ? rawTarget.slice(separator + 1) : '443';
    let target: SafeNetworkTarget;
    try {
      if (!/^\d+$/.test(rawPort)) throw new SsrfPolicyError('Invalid CONNECT port.');
      target = await validateSsrfUrl(`https://${host}:${rawPort}`);
    } catch {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstreamSocket = net.connect({ host: target.address, port: target.port });
    this.trackSocket(upstreamSocket);
    this.trackSocket(clientSocket);
    upstreamSocket.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    const close = () => {
      upstreamSocket.destroy();
      clientSocket.destroy();
      this.sockets.delete(upstreamSocket);
      this.sockets.delete(clientSocket);
    };
    upstreamSocket.once('error', close);
    clientSocket.once('error', close);
    upstreamSocket.once('close', close);
    clientSocket.once('close', close);
  }

  private trackSocket(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }
}

function pinnedLookup(target: SafeNetworkTarget): LookupFunction {
  return ((_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
    callback(null, target.address, target.family);
  }) as LookupFunction;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  return hostname === 'localhost' || BLOCKED_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix));
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 0 && c === 96) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  if (bytes.every(byte => byte === 0)) return false;
  if (bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1) return false;
  const isMapped = bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isMapped) return isPublicIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  if ((bytes[0] & 0xfe) === 0xfc) return false;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false;
  if (bytes[0] === 0xff) return false;
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01) {
    if (bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
    if (bytes[2] === 0x00) return false;
    if (bytes[2] === 0x00 && bytes[3] <= 0x0f) return false;
    if (bytes[2] === 0x00 && bytes[3] >= 0x10 && bytes[3] <= 0x2f) return false;
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return isPublicIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  return true;
}

function ipv6Bytes(address: string): number[] | null {
  if (net.isIP(address) !== 6) return null;
  const [headText, tailText] = address.split('::', 2);
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      const value = Number.parseInt(group, 16);
      groups.push(value >> 8, value & 0xff);
    }
    return groups;
  };
  const head = parse(headText);
  const tail = tailText === undefined ? [] : parse(tailText);
  if (!head || !tail) return null;
  if (address.includes('::')) {
    if (head.length + tail.length >= 16) return null;
    return [...head, ...Array<number>(16 - head.length - tail.length).fill(0), ...tail];
  }
  return head.length === 16 ? head : null;
}
