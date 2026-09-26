/**
 * Security and reachability tests for the admin dashboard.
 *
 * The dashboard shares a port with webhook intake, so the auth boundary is the
 * most important thing here to pin. Two properties must hold absolutely:
 *
 *  1. with no admin token configured, the entire surface is absent
 *  2. with a token configured, nothing is readable or writable without a
 *     session, and a cookie alone cannot drive a mutation
 *
 * A bug in either would expose telemetry or, worse, the few write operations.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

const { createAdminHandler } = await import('../src/admin/routes');
const {
  AdminAuth,
  LoginThrottle,
  isAdminEnabled,
  isSameOrigin,
  readAdminAuthConfig,
  ADMIN_CSRF_HEADER,
} = await import('../src/admin/auth');

const SECRET = 'test-admin-secret-0123456789';
const HOST = '127.0.0.1:3500';
const BASE = `http://${HOST}`;

const READ_ROUTES = [
  'api/overview', 'api/tools', 'api/rooms', 'api/delivery',
  'api/reminders', 'api/roomkeys', 'api/feedback', 'api/config',
];

/** Drive the handler the way WebhookServer does, returning a real Response. */
async function call(
  handler: ReturnType<typeof createAdminHandler>,
  path: string,
  init: RequestInit & { ip?: string } = {},
): Promise<Response> {
  const { ip = '10.0.0.1', ...requestInit } = init;
  return handler(
    new Request(`${BASE}/admin/${path}`, requestInit),
    ip,
    { hostname: HOST },
  );
}

function handlerWith(secret: string) {
  return createAdminHandler({
    auth: new AdminAuth({ secret, cookieSecure: false }),
    throttle: new LoginThrottle(5, 60_000),
  });
}

/** Log in and return the cookie + CSRF pair the client would hold. */
async function signIn(handler: ReturnType<typeof createAdminHandler>, secret = SECRET) {
  const response = await call(handler, 'api/login', {
    method: 'POST',
    body: JSON.stringify({ token: secret }),
    headers: { 'Content-Type': 'application/json' },
  });
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  const { csrf } = await response.json() as { csrf: string };
  return { cookie, csrf };
}

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {
    METRICS_AUTH_TOKEN: process.env.METRICS_AUTH_TOKEN,
    ADMIN_COOKIE_INSECURE: process.env.ADMIN_COOKIE_INSECURE,
  };
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('admin enablement', () => {
  test('is disabled without a token', () => {
    delete process.env.METRICS_AUTH_TOKEN;
    expect(isAdminEnabled(readAdminAuthConfig())).toBe(false);
  });

  test('requires a reasonably long secret', () => {
    process.env.METRICS_AUTH_TOKEN = 'short';
    expect(isAdminEnabled(readAdminAuthConfig())).toBe(false);
    process.env.METRICS_AUTH_TOKEN = SECRET;
    expect(isAdminEnabled(readAdminAuthConfig())).toBe(true);
  });

  test('marks the cookie Secure by default and allows an explicit opt-out', () => {
    process.env.METRICS_AUTH_TOKEN = SECRET;
    delete process.env.ADMIN_COOKIE_INSECURE;
    expect(readAdminAuthConfig().cookieSecure).toBe(true);
    // A loopback deployment reached over plain HTTP cannot use a Secure cookie.
    process.env.ADMIN_COOKIE_INSECURE = 'true';
    expect(readAdminAuthConfig().cookieSecure).toBe(false);
  });

  test('answers 404 for every path when unconfigured', async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    const handler = createAdminHandler();
    for (const route of ['', 'login', 'api/overview', 'api/session']) {
      const response = await call(handler, route);
      expect(response.status, `${route} must not exist without a token`).toBe(404);
    }
  });
});

describe('admin authentication', () => {
  test('rejects a wrong token', async () => {
    const handler = handlerWith(SECRET);
    const response = await call(handler, 'api/login', {
      method: 'POST',
      body: JSON.stringify({ token: 'not-the-secret' }),
    });
    expect(response.status).toBe(401);
  });

  test('rejects a missing or malformed body', async () => {
    const handler = handlerWith(SECRET);
    expect((await call(handler, 'api/login', { method: 'POST' })).status).toBe(400);
    expect((await call(handler, 'api/login', {
      method: 'POST', body: JSON.stringify({}),
    })).status).toBe(401);
  });

  test('issues an HttpOnly, SameSite=Strict cookie that does not contain the secret', async () => {
    const handler = handlerWith(SECRET);
    const response = await call(handler, 'api/login', {
      method: 'POST',
      body: JSON.stringify({ token: SECRET }),
    });
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/admin');
    // The secret must never be recoverable from the cookie.
    expect(cookie).not.toContain(SECRET);
    // A Max-Age of 0 would make a browser drop the session immediately. This
    // was broken once and only a live browser-shaped request exposed it.
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1] ?? '0');
    expect(maxAge).toBeGreaterThan(300);
  });

  test('refuses every read route without a session', async () => {
    const handler = handlerWith(SECRET);
    for (const route of READ_ROUTES) {
      const response = await call(handler, route);
      expect(response.status, `${route} must require a session`).toBe(401);
    }
  });

  test('refuses a forged cookie', async () => {
    const handler = handlerWith(SECRET);
    const response = await call(handler, 'api/overview', {
      headers: { cookie: 'elastrax_admin=made-up.signature' },
    });
    expect(response.status).toBe(401);
  });

  test('refuses another deployment\'s valid-looking cookie', async () => {
    const issued = await signIn(handlerWith(SECRET));
    // Same id, signature from a different secret.
    const other = handlerWith('a-completely-different-secret');
    const response = await call(other, 'api/overview', { headers: { cookie: issued.cookie } });
    expect(response.status).toBe(401);
  });

  test('rate limits repeated failed logins per IP', async () => {
    const handler = handlerWith(SECRET);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await call(handler, 'api/login', {
        method: 'POST',
        body: JSON.stringify({ token: 'wrong' }),
        ip: '10.0.0.9',
      });
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
  });

  test('a throttled IP does not lock out a different IP', async () => {
    const handler = handlerWith(SECRET);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await call(handler, 'api/login', { method: 'POST', body: JSON.stringify({ token: 'wrong' }), ip: '10.0.0.9' });
    }
    const other = await call(handler, 'api/login', {
      method: 'POST', body: JSON.stringify({ token: SECRET }), ip: '10.0.0.10',
    });
    expect(other.status).toBe(200);
  });
});

describe('admin read reachability', () => {
  test('every read route is reachable with a session', async () => {
    const handler = handlerWith(SECRET);
    const { cookie } = await signIn(handler);
    for (const route of READ_ROUTES) {
      const response = await call(handler, route, { headers: { cookie } });
      expect(response.status, `${route} should be reachable`).toBe(200);
      // A real payload, not an error envelope.
      expect(response.headers.get('content-type')).toContain('application/json');
    }
  });

  test('an unknown read route is a 404, not a crash', async () => {
    const handler = handlerWith(SECRET);
    const { cookie } = await signIn(handler);
    expect((await call(handler, 'api/nope', { headers: { cookie } })).status).toBe(404);
  });

  test('the overview reports version and uptime', async () => {
    const handler = handlerWith(SECRET);
    const { cookie } = await signIn(handler);
    const payload = await (await call(handler, 'api/overview', { headers: { cookie } })).json() as Record<string, unknown>;
    expect(typeof payload.version).toBe('string');
    expect(typeof payload.uptimeSeconds).toBe('number');
    expect(payload.messages).toBeDefined();
  });

  test('the config view never returns a secret value', async () => {
    const handler = handlerWith(SECRET);
    const { cookie } = await signIn(handler);
    const response = await call(handler, 'api/config', { headers: { cookie } });
    const body = await response.text();
    // The admin token must not appear anywhere in the config payload.
    expect(body).not.toContain(SECRET);
    const payload = JSON.parse(body) as { keys: Array<{ name: string; value: string; secret: boolean }> };
    for (const entry of payload.keys) {
      if (entry.secret) expect(entry.value === 'set' || entry.value === '(unset)').toBe(true);
    }
  });

  test('the tools view lists the registry with per-tool stats', async () => {
    const handler = handlerWith(SECRET);
    const { cookie } = await signIn(handler);
    const payload = await (await call(handler, 'api/tools', { headers: { cookie } })).json() as {
      tools: Array<{ name: string; invocations: number }>;
    };
    expect(payload.tools.length).toBeGreaterThan(0);
    expect(payload.tools.some(tool => tool.name === 'web_search')).toBe(true);
  });
});

describe('admin mutations', () => {
  test('a cookie alone cannot drive a mutation', async () => {
    // The exact CSRF shape: a browser sends the cookie automatically.
    const handler = handlerWith(SECRET);
    const { cookie } = await signIn(handler);
    const response = await call(handler, 'api/action/reload-registry', {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(response.status).toBe(403);
  });

  test('a valid session with the CSRF token is accepted', async () => {
    const handler = handlerWith(SECRET);
    const { cookie, csrf } = await signIn(handler);
    const response = await call(handler, 'api/action/retention-report', {
      method: 'POST',
      headers: { cookie, [ADMIN_CSRF_HEADER]: csrf, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);
  });

  test('a CSRF token from another session is rejected', async () => {
    const handler = handlerWith(SECRET);
    const first = await signIn(handler);
    const second = await signIn(handler);
    const response = await call(handler, 'api/action/retention-report', {
      method: 'POST',
      headers: { cookie: second.cookie, [ADMIN_CSRF_HEADER]: first.csrf, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  test('a cross-origin mutation is rejected', async () => {
    const handler = handlerWith(SECRET);
    const { cookie, csrf } = await signIn(handler);
    const response = await call(handler, 'api/action/reload-registry', {
      method: 'POST',
      headers: { cookie, [ADMIN_CSRF_HEADER]: csrf, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  test('rejects unsupported verbs', async () => {
    const handler = handlerWith(SECRET);
    const { cookie, csrf } = await signIn(handler);
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const response = await call(handler, 'api/overview', {
        method, headers: { cookie, [ADMIN_CSRF_HEADER]: csrf },
      });
      expect(response.status, `${method} must not be accepted`).toBe(405);
    }
  });

  test('a mutation with no session is rejected before the CSRF check', async () => {
    const handler = handlerWith(SECRET);
    const response = await call(handler, 'api/action/reload-registry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(response.status).toBe(401);
  });

  test('logout invalidates the session', async () => {
    const handler = handlerWith(SECRET);
    const { cookie, csrf } = await signIn(handler);
    expect((await call(handler, 'api/overview', { headers: { cookie } })).status).toBe(200);
    await call(handler, 'api/logout', {
      method: 'POST', headers: { cookie, [ADMIN_CSRF_HEADER]: csrf },
    });
    expect((await call(handler, 'api/overview', { headers: { cookie } })).status).toBe(401);
  });
});

describe('admin static assets', () => {
  test('serves the shell and assets with a strict CSP', async () => {
    const handler = handlerWith(SECRET);
    const { cookie } = await signIn(handler);
    const shell = await call(handler, '', { headers: { cookie } });
    expect(shell.status).toBe(200);
    expect(shell.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(shell.headers.get('x-content-type-options')).toBe('nosniff');

    const script = await call(handler, 'app.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('javascript');
  });

  test('redirects to login without a session', async () => {
    const handler = handlerWith(SECRET);
    const response = await call(handler, '');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/login');
  });

  test('never parses HTML in the client bundle', async () => {
    // Room names, error strings and feedback text all originate from users, so
    // the bundle must build DOM without HTML parsing. Comments are stripped
    // first: the bundle documents that it does not use innerHTML, and that
    // sentence would otherwise fail the very check it describes.
    const handler = handlerWith(SECRET);
    const raw = await (await call(handler, 'app.js')).text();
    const code = raw
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('innerHTML');
    expect(code).not.toContain('outerHTML');
    expect(code).not.toContain('insertAdjacentHTML');
    expect(code).not.toContain('document.write');
    expect(code).toContain('document.createTextNode');
  });
});

describe('same-origin helper', () => {
  test('allows a missing origin (non-browser client)', () => {
    expect(isSameOrigin(new Request(`${BASE}/admin/`), HOST)).toBe(true);
  });

  test('rejects a foreign origin', () => {
    expect(isSameOrigin(new Request(`${BASE}/admin/`, { headers: { Origin: 'https://evil.example' } }), HOST)).toBe(false);
  });

  test('allows the same origin', () => {
    expect(isSameOrigin(new Request(`${BASE}/admin/`, { headers: { Origin: BASE } }), HOST)).toBe(true);
  });
});
