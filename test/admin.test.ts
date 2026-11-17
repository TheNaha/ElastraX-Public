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
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import * as fsModule from 'node:fs';
import * as pathModule from 'node:path';
import * as osModule from 'node:os';

const { createAdminHandler } = await import('../src/admin/routes');
const { APP_JS } = await import('../src/admin/routes');
const {
  AdminAuth,
  LoginThrottle,
  isAdminEnabled,
  isSameOrigin,
  readAdminAuthConfig,
  ADMIN_CSRF_HEADER,
} = await import('../src/admin/auth');
const adminAuth = await import('../src/admin/auth');
const adminData = await import('../src/admin/data');
const { db: adminDb } = await import('../src/db');
const { messageOutbox: outboxTable, chatRooms: roomsTable, memories: memoriesTable } = await import('../src/db/schema');

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

  test('logout with a forged cookie does not invalidate the real session', () => {
    const auth = new AdminAuth({ secret: SECRET, cookieSecure: false });
    const issued = auth.login(SECRET);
    expect(issued).not.toBeNull();
    const cookieValue = issued!.cookieValue;
    const id = cookieValue.slice(0, cookieValue.lastIndexOf('.'));

    auth.logout(`${id}.forged`);
    expect(auth.verify(cookieValue)).not.toBeNull();

    auth.logout(cookieValue);
    expect(auth.verify(cookieValue)).toBeNull();
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

  test('an action that throws answers the ActionResult shape, not a bare 500', async () => {
    const handler = handlerWith(SECRET);
    const { cookie, csrf } = await signIn(handler);
    // `actionDeleteKnowledge` deliberately throws for a malformed document id.
    const response = await call(handler, 'api/action/delete-knowledge', {
      method: 'POST',
      headers: { cookie, [ADMIN_CSRF_HEADER]: csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomKey: 'room:whatsapp:r1', documentId: 'not a document id!' }),
    });
    expect(response.status).toBe(400);
    const payload = await response.json() as { ok: boolean; message: string };
    expect(payload.ok).toBe(false);
    // The exact reason depends on what the room contains; what matters is that the
    // actionable message reaches the client instead of a bare "Internal server error".
    expect(payload.message.length).toBeGreaterThan(0);
    expect(payload.message).not.toContain('Internal server error');
  });

  test('an unknown action is a 404 even with a malformed body', async () => {
    const handler = handlerWith(SECRET);
    const { cookie, csrf } = await signIn(handler);
    const response = await call(handler, 'api/action/does-not-exist', {
      method: 'POST',
      headers: { cookie, [ADMIN_CSRF_HEADER]: csrf, 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(response.status).toBe(404);
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

  test('rejects an oversized login body before parsing it', async () => {
    const handler = handlerWith(SECRET);
    const response = await call(handler, 'api/login', {
      method: 'POST',
      body: JSON.stringify({ token: 'x'.repeat(8_000) }),
      ip: '10.0.0.77',
    });
    expect(response.status).toBe(413);
  });

  test('rejects an oversized action body', async () => {
    const handler = handlerWith(SECRET);
    const { cookie, csrf } = await signIn(handler);
    const response = await call(handler, 'api/action/retention-report', {
      method: 'POST',
      headers: { cookie, [ADMIN_CSRF_HEADER]: csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(80_000) }),
    });
    expect(response.status).toBe(413);
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

describe('admin hardening', () => {
  const { LoginThrottle: Throttle } = adminAuth;
  const { feedbackInventory } = adminData;

  test('bounds the login throttle map under a flood of distinct IPs', () => {
    const throttle = new Throttle(5, 60_000);
    const now = Date.now();
    for (let index = 0; index < 12_000; index += 1) {
      throttle.attempt(`10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`, now);
    }
    expect(throttle.size).toBeLessThanOrEqual(10_000);
    // The most recent IP is still tracked, so a live client keeps its history.
    expect(throttle.attempt('10.255.255.255', now)).toBe(true);
  });

  test('treats an IPv6 loopback host as local for the cookie flag', () => {
    const { shouldUseSecureCookie } = adminAuth;
    const request = new Request('http://[::1]:3500/admin');
    const url = new URL('http://[::1]:3500/admin');
    // Plain HTTP on loopback: a Secure cookie would be dropped by the browser and
    // the dashboard would loop between login and 401.
    expect(shouldUseSecureCookie(request, url, true)).toBe(false);
    expect(shouldUseSecureCookie(
      new Request('http://[::1]:3500/admin', { headers: { host: '[::1]:3500' } }),
      url,
      true,
    )).toBe(false);
    // A trailing dot is the same host.
    expect(shouldUseSecureCookie(
      new Request('http://localhost.:3500/admin', { headers: { host: 'localhost.:3500' } }),
      new URL('http://localhost.:3500/admin'),
      true,
    )).toBe(false);
    // A forwarded https proto still wins.
    expect(shouldUseSecureCookie(
      new Request('http://bot:3500/admin', { headers: { 'x-forwarded-proto': 'https' } }),
      new URL('http://bot:3500/admin'),
      true,
    )).toBe(true);
  });

  test('config view strips credentials embedded in URLs', () => {
    const { configInventory } = adminData;
    const inventory = configInventory({
      AI_API_BASE_URL: 'https://user:secret-key@llm.example/v1?api_key=abc123',
      SEERR_URL: 'https://seerr.example',
    } as NodeJS.ProcessEnv);
    const base = inventory.keys.find(entry => entry.name === 'AI_API_BASE_URL')!;
    expect(base.value).not.toContain('secret-key');
    expect(base.value).not.toContain('abc123');
    expect(base.value).toContain('llm.example');
    const plain = inventory.keys.find(entry => entry.name === 'SEERR_URL')!;
    expect(plain.value).toBe('https://seerr.example/');
  });

  test('reports a truncated feedback tail instead of silently narrowing it', () => {
    const { mkdtempSync, writeFileSync } = fsModule;
    const { join } = pathModule;
    const { tmpdir } = osModule;
    const dir = mkdtempSync(join(tmpdir(), 'feedback-tail-'));
    const path = join(dir, 'feedback.jsonl');
    const line = JSON.stringify({ at: 't', platform: 'whatsapp', chatRoomId: 'r', sentiment: 'positive', reaction: '👍' });
    // 60 000 lines is comfortably past the 1 MiB tail window.
    writeFileSync(path, `${Array.from({ length: 60_000 }, () => line).join('\n')}\n`);
    const previous = process.env.FEEDBACK_LOG_PATH;
    process.env.FEEDBACK_LOG_PATH = path;
    try {
      const inventory = feedbackInventory(5);
      expect(inventory.truncated).toBe(true);
      expect(inventory.entries.length).toBe(5);
      expect(inventory.entries.every(entry => entry.sentiment === 'positive')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.FEEDBACK_LOG_PATH;
      else process.env.FEEDBACK_LOG_PATH = previous;
    }
  });
});

describe('admin outbox retry action', () => {
  const { actionRetryOutbox } = adminData;
  const db = adminDb;
  const messageOutbox = outboxTable;

  function seedRow(state: 'sent' | 'dead_letter'): string {
    const id = `retry-${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    db.insert(messageOutbox).values({
      id,
      platform: 'whatsapp',
      chatRoomId: `room-${id}`,
      roomKey: `room:whatsapp:room-${id}`,
      idempotencyKey: `key-${id}`,
      payload: JSON.stringify({ text: 'hello' }),
      state,
      attemptCount: 5,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    return id;
  }

  test('refuses to resurrect a row that is no longer failed or dead-lettered', async () => {
    // The action read the row, checked its state, then updated with no state
    // predicate: a row the worker delivered in between was returned to pending
    // and sent a second time.
    const id = seedRow('sent');
    const result = await actionRetryOutbox(id);
    expect(result.ok).toBe(false);
    const [row] = db.select().from(messageOutbox).where(eq(messageOutbox.id, id)).all();
    expect(row?.state).toBe('sent');
  });

  test('requeues a dead-lettered row', async () => {
    const id = seedRow('dead_letter');
    const result = await actionRetryOutbox(id);
    expect(result.ok).toBe(true);
    const [row] = db.select().from(messageOutbox).where(eq(messageOutbox.id, id)).all();
    expect(row?.state).toBe('pending');
    expect(row?.attemptCount).toBe(0);
  });
});

describe('admin room inventory', () => {
  const { roomInventory } = adminData;

  test('counts documents, not chunks', () => {
    // Room knowledge stores one row per chunk. Counting rows turned a 2-chunk
    // document into two "documents" in the Rooms table.
    const suffix = Math.random().toString(36).slice(2, 10);
    const roomKey = `room:whatsapp:inventory-${suffix}`;
    const now = new Date();
    adminDb.insert(roomsTable).values({
      id: roomKey,
      platform: 'whatsapp',
      roomKey,
      created_at: now,
    }).run();
    const chunks = [
      { id: `docA_${suffix}_0`, content: '[source: guide #1] first' },
      { id: `docA_${suffix}_1`, content: '[source: guide #2] second' },
      { id: `docB_${suffix}_0`, content: '[source: notes #1] only' },
    ];
    for (const chunk of chunks) {
      adminDb.insert(memoriesTable).values({
        id: chunk.id,
        ownerId: roomKey,
        content: chunk.content,
        category: 'document',
        created_at: now,
      }).run();
    }

    const inventory = roomInventory();
    const room = inventory.rooms.find(entry => entry.roomKey === roomKey);
    expect(room?.knowledgeDocuments).toBe(2);
  });
});

describe('admin app bundle', () => {
  class StubNode {
    nodeType = 'element';
    className = '';
    textContent = '';
    readonly attrs: Record<string, string> = {};
    readonly children: unknown[] = [];
    setAttribute(name: string, value: string): void {
      this.attrs[name] = value;
    }
    addEventListener(): void {}
    append(...kids: unknown[]): void {
      this.children.push(...kids);
    }
  }

  test('every embedded view renders against a minimal DOM', async () => {
    // APP_JS is a plain string, so tsc and eslint never see it. A helper that
    // is called but never declared (the bug this guards against) would only
    // fail at runtime, in the operator's browser, on one tab.
    const responses: Record<string, unknown> = {
      'api/overview': {
        uptimeSeconds: 60, version: 'v1', services: {},
        messages: { received: 0, errors: 0 }, llm: { durationP95: 0, requests: 0 },
        tokens: { total: 0, models: [] }, queue: { totalPending: 0, totalRunning: 0 },
        feedback: { positive: 0, negative: 0 },
      },
      'api/tools': { catalogSize: 0, alwaysLoaded: [], plugins: [], tools: [] },
      'api/rooms': { total: 0, keyStats: {}, rooms: [] },
      'api/delivery': { outbox: { byState: {}, rows: [] }, inbox: { byState: {}, stranded: [] } },
      'api/reminders': { pending: 0, rows: [], flows: { total: 0, oldest: null } },
      'api/roomkeys': { total: 0, rows: [] },
      'api/feedback': { positive: 0, negative: 0, ratio: null, entries: [], truncated: false },
      'api/config': { missing: [], keys: [] },
    };
    const documentStub = {
      createElement: () => new StubNode(),
      createTextNode: (text: string) => ({ text }),
      addEventListener: () => {},
      getElementById: () => new StubNode(),
      querySelectorAll: () => [],
    };
    const fetchStub = async (path: string) => ({
      ok: true,
      status: 200,
      json: async () => responses[String(path).replace('/admin/', '')] ?? {},
    });
    const factory = new Function(
      'document', 'fetch', 'Node', 'location', 'window', 'setTimeout', 'clearTimeout', 'confirm', 'console',
      `${APP_JS}\nreturn VIEWS;`,
    );
    const views = factory(
      documentStub, fetchStub, StubNode, { href: '' }, {}, () => 0, () => {}, () => true, console,
    ) as Record<string, () => Promise<unknown[]>>;

    const names = Object.keys(views);
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const name of names) {
      const nodes = await views[name]!();
      expect(Array.isArray(nodes)).toBe(true);
    }
  });
});
