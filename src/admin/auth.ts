/**
 * @file src/admin/auth.ts
 * @description Authentication for the admin dashboard.
 *
 * The dashboard lives on the same port as webhook intake, so its auth is the one
 * thing standing between an unauthenticated request and the whole telemetry
 * surface. Design:
 *
 *  - one shared secret (reuses `METRICS_AUTH_TOKEN`, the token that already
 *    gates `/metrics`) — there are no user accounts, because this is a
 *    single-operator tool and accounts would multiply the attack surface
 *  - the secret is never placed in a cookie. The cookie holds an HMAC of the
 *    secret under a server-side session id, so a stolen cookie is useless
 *    without the secret and cannot be replayed as a bearer token
 *  - `HttpOnly` + `SameSite=Strict` + `Secure`, so script cannot read it and it
 *    is not sent on cross-site requests
 *  - every mutating request additionally requires a CSRF token bound to the
 *    session, because a cookie is sent automatically and a bearer token is not
 *  - login attempts are rate limited per IP
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { isUsableSharedSecret, readStringEnv } from '../config/runtime';

export const ADMIN_SESSION_COOKIE = 'elastrax_admin';
export const ADMIN_CSRF_HEADER = 'x-admin-csrf';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 32;

export type AdminAuthConfig = {
  /** Shared secret; empty means the dashboard is disabled entirely. */
  secret: string;
  cookieSecure: boolean;
};

export function readAdminAuthConfig(env: NodeJS.ProcessEnv = process.env): AdminAuthConfig {
  return {
    secret: readStringEnv(env.METRICS_AUTH_TOKEN),
    // A `Secure` cookie cannot be sent over plain HTTP, which would lock the
    // operator out of a loopback-only deployment reached without TLS. So this is
    // opt-in: the dashboard is secure by default, and an operator serving it
    // over plain HTTP to localhost must say so explicitly.
    cookieSecure: !/^(1|true|yes|on)$/i.test(readStringEnv(env.ADMIN_COOKIE_INSECURE)),
  };
}

export function isAdminEnabled(config: AdminAuthConfig): boolean {
  return isUsableSharedSecret(config.secret);
}

function sign(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/**
 * Constant-time comparison that does not leak length through early exit.
 *
 * Both sides are hashed first, so the comparison always runs over two
 * fixed-size digests. Comparing the raw buffers leaked the secret's length
 * through the early return on a length mismatch — exactly the signal the
 * previous comment claimed to prevent.
 */
function safeEqual(a: string, b: string): boolean {
  const left = createHmac('sha256', 'elastrax-admin-compare').update(a).digest();
  const right = createHmac('sha256', 'elastrax-admin-compare').update(b).digest();
  return timingSafeEqual(left, right);
}

type Session = { id: string; csrf: string; expiresAt: number };

export class AdminAuth {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly config: AdminAuthConfig) {}

  /**
   * Whether the dashboard is enabled at all. Exposed so the router derives
   * enablement from this instance rather than re-reading the environment, which
   * would let an injected auth and the router disagree.
   */
  get isEnabled(): boolean {
    return isAdminEnabled(this.config);
  }

  /**
   * Whether the `Secure` cookie attribute is on by default.
   *
   * The router combines this with the transport of the individual request, so
   * a loopback deployment over plain HTTP is not locked out while a remote
   * deployment keeps the attribute.
   */
  get cookieSecureByDefault(): boolean {
    return this.config.cookieSecure;
  }

  /** The CSRF token to hand out alongside a freshly minted session cookie. */
  private issue(): { cookieValue: string; csrf: string } {
    const id = randomBytes(24).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    // Signed so a forged id cannot be presented as a session.
    const cookieValue = `${id}.${sign(this.config.secret, id)}`;
    this.sessions.set(id, { id, csrf, expiresAt: Date.now() + SESSION_TTL_MS });
    // Bounded: evict the oldest so a login flood cannot grow this without limit.
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
    return { cookieValue, csrf };
  }

  /** Verify a presented secret and mint a session. Returns null when invalid. */
  login(presented: string | null, now = Date.now()): { cookieValue: string; csrf: string } | null {
    if (!isAdminEnabled(this.config) || !presented) return null;
    if (!safeEqual(presented, this.config.secret)) return null;
    this.prune(now);
    return this.issue();
  }

  private prune(now: number): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  /** Validate a session cookie and return its CSRF token. */
  verify(cookieValue: string | null, now = Date.now()): { csrf: string } | null {
    if (!isAdminEnabled(this.config) || !cookieValue) return null;
    const separator = cookieValue.lastIndexOf('.');
    if (separator <= 0) return null;
    const id = cookieValue.slice(0, separator);
    const signature = cookieValue.slice(separator + 1);
    if (!safeEqual(signature, sign(this.config.secret, id))) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= now) {
      this.sessions.delete(id);
      return null;
    }
    return { csrf: session.csrf };
  }

  /** A CSRF token is only valid for the session that issued it. */
  verifyCsrf(cookieValue: string | null, presented: string | null, now = Date.now()): boolean {
    const session = this.verify(cookieValue, now);
    if (!session) return false;
    if (!presented) return false;
    return safeEqual(session.csrf, presented);
  }

  logout(cookieValue: string | null): void {
    if (!cookieValue) return;
    const separator = cookieValue.lastIndexOf('.');
    if (separator > 0) this.sessions.delete(cookieValue.slice(0, separator));
  }

  /**
   * Build the session cookie.
   *
   * `secure` lets the caller downgrade the `Secure` attribute for a request
   * that arrived over plain HTTP on loopback. A browser silently refuses to
   * store a `Secure` cookie over plain HTTP, so a loopback-only deployment
   * could never keep a session — the operator would sign in, the cookie would
   * be dropped, and every subsequent request would come back 401. Remote
   * deployments keep the attribute.
   */
  buildCookie(cookieValue: string, secure: boolean = this.config.cookieSecure): string {
    // The session TTL is a constant, so the cookie's Max-Age is that TTL. It is
    // deliberately not derived from the current time: doing so produced Max-Age=0
    // and a browser would drop the session on the very next request. A live
    // smoke test caught this, not the unit tests, because they carried the
    // cookie by hand instead of through a cookie jar.
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    const parts = [
      `${ADMIN_SESSION_COOKIE}=${cookieValue}`,
      'Path=/admin',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAge}`,
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  clearCookie(): string {
    return `${ADMIN_SESSION_COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
}

/** Whether a `Host` value names the local machine. */
export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

/**
 * Whether the session cookie should carry the `Secure` attribute.
 *
 * A browser refuses to store a `Secure` cookie that arrives over plain HTTP,
 * so the attribute can only be set when the request really is secure (direct
 * TLS, or a proxy that says so) — or when the operator explicitly opted out
 * with `ADMIN_COOKIE_INSECURE`.
 *
 * The one exception is loopback over plain HTTP: that is the standard local
 * deployment, and demanding TLS there locked the operator out of the
 * dashboard entirely.
 */
export function shouldUseSecureCookie(
  req: Request,
  url: URL,
  secureByDefault: boolean,
): boolean {
  if (!secureByDefault) return false;
  const forwarded = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded === 'https') return true;
  if (url.protocol === 'https:') return true;
  const host = (req.headers.get('host') ?? url.host).split(':')[0] ?? '';
  return !isLoopbackHost(host);
}

/** Per-IP token bucket for login attempts. */
export class LoginThrottle {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 60_000,
  ) {}

  /** Returns true when the attempt is allowed (and records it). */
  attempt(ip: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(ip, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.limit) return false;
    bucket.count += 1;
    return true;
  }

  get size(): number {
    return this.buckets.size;
  }

  prune(now = Date.now()): void {
    for (const [ip, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(ip);
    }
  }
}

/**
 * Reject cross-origin mutations.
 *
 * The session cookie is `SameSite=Strict`, which already blocks most cross-site
 * delivery, but an explicit origin check means a browser that ignores the cookie
 * policy still cannot drive a mutation.
 *
 * The comparison is case-insensitive because a host is case-insensitive, and
 * `new URL(...).host` lower-cases while a raw `Host` header may not.
 */
export function isSameOrigin(req: Request, expectedHost: string | null): boolean {
  const origin = req.headers.get('origin');
  // A missing Origin is a non-browser client (curl, the test suite) which cannot
  // be a CSRF vector; the cookie+CSRF pair still applies.
  if (!origin) return true;
  if (!expectedHost) return false;
  try {
    return new URL(origin).host.toLowerCase() === expectedHost.toLowerCase();
  } catch {
    return false;
  }
}
