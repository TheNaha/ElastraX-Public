/**
 * @file src/admin/routes.ts
 * @description HTTP routing for the admin dashboard.
 *
 * Mounted into the existing WebhookServer at `/admin/*` rather than given its own
 * port, so all of this lives in one place and `WebhookServer` only grows a
 * single delegation branch.
 *
 * Security posture, since this shares a port with webhook intake:
 *  - disabled entirely unless `METRICS_AUTH_TOKEN` is a 24+ byte secret
 *  - the secret is never placed in a cookie, only an HMAC of a session id is
 *  - every mutating request needs same-origin, a valid session, and a CSRF token
 *  - login is rate limited per IP
 *  - no route returns a secret; config is filtered through an allowlist
 *  - UI assets are served with a strict CSP and no inline script execution
 */
import {
  AdminAuth,
  LoginThrottle,
  isSameOrigin,
  readAdminAuthConfig,
  shouldUseSecureCookie,
  ADMIN_CSRF_HEADER,
  ADMIN_SESSION_COOKIE,
} from './auth';
import {
  buildOverview,
  configInventory,
  feedbackInventory,
  flowSessionInventory,
  inboxInventory,
  outboxInventory,
  reminderInventory,
  roomInventory,
  roomKeyInventory,
  tokenSpend,
  toolInventory,
  actionDeleteKnowledge,
  actionReloadRegistry,
  actionRetentionReport,
  actionRetryOutbox,
  type ActionResult,
} from './data';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { readRequestBytesWithLimit, WebhookRequestError } from '../webhooks/utils';

const log = logger.child({ module: 'AdminRoutes' });

/** Only these verbs are ever accepted. */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

/**
 * Caps for admin request bodies.
 *
 * The webhook intake path already reads through `readRequestBytesWithLimit`;
 * the dashboard called `req.json()` directly, and the shared `Bun.serve`
 * instance sets no `maxRequestBodySize`, so an unauthenticated client could push
 * an arbitrarily large body into a full JSON parse on the event loop before the
 * token was ever checked. Admin bodies are tiny: a token, an id, a room key.
 */
const ADMIN_LOGIN_MAX_BODY_BYTES = 4 * 1024;
const ADMIN_ACTION_MAX_BODY_BYTES = 64 * 1024;

type JsonBodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 400 | 408 | 413; error: string };

/** Read a bounded, object-shaped JSON body. Never throws. */
async function readJsonObjectBody(req: Request, maxBytes: number): Promise<JsonBodyResult> {
  let text: string;
  try {
    const bytes = await readRequestBytesWithLimit(req, maxBytes);
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof WebhookRequestError) {
      const status = error.status === 400 || error.status === 408 ? error.status : 413;
      return { ok: false, status, error: error.message };
    }
    return { ok: false, status: 400, error: 'Invalid request body.' };
  }
  try {
    const parsed: unknown = text.trim() === '' ? null : JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: 'Invalid JSON body.' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON body.' };
  }
}

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    },
  });
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}

/**
 * The hosts an `Origin` header may name for a mutation to be accepted.
 *
 * The request's own `Host` header is the authority here, because that is the
 * name the browser used to reach us and it includes the port.
 *
 * The previous implementation preferred `server.hostname`, but Bun documents
 * that as *the bind address without the port* — `"0.0.0.0"` in a normal
 * deployment. Comparing a browser's `Origin: http://localhost:3500` against
 * `"0.0.0.0"` never matches, so **every** browser mutation was answered with
 * `403 Forbidden`: the operator could load the login page but could never
 * sign in, and the whole dashboard was unreachable. The unit test missed it
 * because it injected a fake server whose `hostname` included the port.
 *
 * `X-Forwarded-Host` is accepted as a second candidate. A proxy that rewrites
 * `Host` (nginx's default `proxy_set_header Host $proxy_host`) otherwise makes
 * the browser's `Origin` unusable while plain reads keep working, which looks
 * like a CSRF failure and is not one. `shouldUseSecureCookie` already trusts the
 * same proxy for `X-Forwarded-Proto`, so this is the same assumption. It does
 * not widen CSRF exposure: a cross-site request cannot set the header without a
 * preflight this server never answers, and the CSRF token is still required.
 */
function readExpectedHosts(req: Request, url: URL, server: unknown): string[] {
  const hosts: string[] = [];
  const hostHeader = req.headers.get('host');
  if (hostHeader) hosts.push(hostHeader);
  const forwarded = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (forwarded) hosts.push(forwarded);
  if (hosts.length > 0) return hosts;
  if (typeof server === 'object' && server !== null && 'hostname' in server) {
    const hostname = String((server as { hostname: unknown }).hostname ?? '').trim();
    if (hostname) return [url.port ? `${hostname}:${url.port}` : hostname];
  }
  return [url.host];
}

export type AdminHandler = (req: Request, ip: string, server: unknown) => Promise<Response> | Response;

export type AdminDeps = {
  now?: () => number;
  /** Injected in tests; defaults to the module functions. */
  auth?: AdminAuth;
  throttle?: LoginThrottle;
};

/**
 * Build the `/admin/*` handler. Returns 404 for everything when no admin secret
 * is configured, so the surface disappears rather than existing unauthenticated.
 */
export function createAdminHandler(deps: AdminDeps = {}): AdminHandler {
  const now = deps.now ?? (() => Date.now());
  const auth = deps.auth ?? new AdminAuth(readAdminAuthConfig());
  const throttle = deps.throttle ?? new LoginThrottle();

  const enabled = auth.isEnabled;
  if (!enabled) {
    log.warn('[Admin] Dashboard disabled: set METRICS_AUTH_TOKEN (24+ bytes) to enable it');
  } else {
    log.info('[Admin] Dashboard enabled at /admin');
  }

  return async function handleAdmin(req: Request, ip: string, server: unknown): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/admin\/?/, '') || '';

    if (!enabled) return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    if (!ALLOWED_METHODS.has(req.method)) {
      return json({ error: 'Method Not Allowed' }, 405, { Allow: 'GET, HEAD, POST' });
    }

    const expectedHosts = readExpectedHosts(req, url, server);

    // ── Static assets (unauthenticated, but they contain no data) ──────────
    if (path === 'app.js') return asset('text/javascript; charset=utf-8', APP_JS);
    if (path === 'style.css') return asset('text/css; charset=utf-8', STYLE_CSS);

    const cookie = readCookie(req, ADMIN_SESSION_COOKIE);

    if (path === '' || path === 'index.html') {
      // The shell is only useful with a session; redirecting avoids flashing an
      // empty page before the client has a chance to check auth.
      if (!auth.verify(cookie, now())) {
        return new Response(null, { status: 302, headers: { Location: '/admin/login' } });
      }
      return asset('text/html; charset=utf-8', APP_SHELL_HTML);
    }
    if (path === 'login') {
      return auth.verify(cookie, now())
        ? new Response(null, { status: 302, headers: { Location: '/admin/' } })
        : loginPage();
    }

    // ── Login ──────────────────────────────────────────────────────────────
    if (path === 'api/login') {
      if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, { Allow: 'POST' });
      if (!isSameOrigin(req, expectedHosts)) return json({ error: 'Forbidden' }, 403);
      // `attempt` sweeps the bucket map itself at most once per window; an
      // explicit prune here walked every tracked IP on every unauthenticated
      // POST.
      if (!throttle.isAllowed(ip, now())) {
        const retryAfter = throttle.retryAfterSeconds(ip, now());
        return json({ error: 'Too many login attempts. Try again shortly.' }, 429, { 'Retry-After': String(retryAfter) });
      }
      const body = await readJsonObjectBody(req, ADMIN_LOGIN_MAX_BODY_BYTES);
      if (!body.ok) return json({ error: body.error }, body.status);
      const presented = typeof body.value.token === 'string' ? body.value.token : '';
      const session = auth.login(presented, now());
      if (!session) {
        // Only a failed attempt consumes the budget.
        throttle.recordFailure(ip, now());
        return json({ error: 'Invalid token.' }, 401);
      }
      throttle.reset(ip);
      return json({ ok: true, csrf: session.csrf }, 200, {
        'Set-Cookie': auth.buildCookie(session.cookieValue, shouldUseSecureCookie(req, url, auth.cookieSecureByDefault)),
      });
    }

    if (path === 'api/logout') {
      if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, { Allow: 'POST' });
      // Logout is a mutation, so it gets the same same-origin check as every
      // other one. It needs no CSRF token — there is no session left to
      // protect — but a cross-site POST must not be able to sign the operator
      // out.
      if (!isSameOrigin(req, expectedHosts)) return json({ error: 'Forbidden' }, 403);
      auth.logout(cookie);
      return json({ ok: true }, 200, { 'Set-Cookie': auth.clearCookie() });
    }

    // ── Everything below requires a session ────────────────────────────────
    const session = auth.verify(cookie, now());
    if (!session) return json({ error: 'Unauthorized' }, 401);

    if (path === 'api/session') {
      return json({ ok: true, csrf: session.csrf });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Mutating: same-origin plus a CSRF token bound to this session.
      if (!isSameOrigin(req, expectedHosts)) return json({ error: 'Forbidden' }, 403);
      const csrf = req.headers.get(ADMIN_CSRF_HEADER);
      if (!auth.verifyCsrfFor(session, csrf)) return json({ error: 'Invalid CSRF token' }, 403);
      return handleAction(req, path, url);
    }

    return handleRead(path, url);
  };
}

function handleRead(path: string, url: URL): Response {
  try {
    switch (path) {
      case 'api/overview':
        return json({ ...buildOverview(), tokens: tokenSpend() });
      case 'api/tools':
        return json(toolInventory());
      case 'api/rooms':
        return json(roomInventory());
      case 'api/delivery':
        return json({
          outbox: outboxInventory({ state: url.searchParams.get('state') ?? undefined }),
          inbox: inboxInventory(),
        });
      case 'api/reminders':
        return json({ ...reminderInventory(), flows: flowSessionInventory() });
      case 'api/roomkeys':
        return json(roomKeyInventory());
      case 'api/feedback':
        return json(feedbackInventory());
      case 'api/config':
        return json(configInventory());
      default:
        return json({ error: 'Not Found' }, 404);
    }
  } catch (error) {
    // A broken query must not take down the page, and must not leak internals.
    log.error({ err: error, path }, '[Admin] Read failed');
    return json({ error: 'Failed to load this view.' }, 500);
  }
}

/**
 * One handler per action path: the map is the route table, so an entry cannot be
 * reachable from the 404 check but missing from the dispatch (or the reverse).
 */
const ADMIN_ACTIONS: Record<string, (params: Record<string, unknown>, url: URL) => Promise<ActionResult> | ActionResult> = {
  'api/action/reload-registry': () => actionReloadRegistry(),
  'api/action/retry-outbox': (params, url) =>
    actionRetryOutbox(String(params.id ?? url.searchParams.get('id') ?? '')),
  'api/action/delete-knowledge': params =>
    actionDeleteKnowledge(
      String(params.roomKey ?? ''),
      typeof params.documentId === 'string' ? params.documentId : undefined,
    ),
  'api/action/retention-report': () => actionRetentionReport(),
};

async function handleAction(req: Request, path: string, url: URL): Promise<Response> {
  // Resolve the action before reading the body: an unknown path is a 404
  // regardless of how malformed the payload is.
  const action = ADMIN_ACTIONS[path];
  if (!action) return json({ error: 'Not Found' }, 404);

  const body = await readJsonObjectBody(req, ADMIN_ACTION_MAX_BODY_BYTES);
  if (!body.ok) return json({ error: body.error }, body.status);
  const params = body.value;

  try {
    const result = await action(params, url);
    return json(result, result.ok ? 200 : 400);
  } catch (error) {
    // `actionDeleteKnowledge` throws for a malformed document id, and a database
    // failure can escape any action. Without this boundary the handler answered a
    // bare 500 instead of the `{ok:false, message}` shape the UI understands.
    log.warn({ err: error, path }, '[Admin] Action failed');
    return json({ ok: false, message: getErrorMessage(error) }, 400);
  }
}

function asset(contentType: string, body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      // The shell must not be cached, or a stale asset outlives a deploy.
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function loginPage(): Response {
  return new Response(LOGIN_HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

const LOGIN_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ElastraX · sign in</title><link rel="stylesheet" href="/admin/style.css"></head>
<body class="login-page">
<form id="login" class="card login-card" autocomplete="off">
  <h1>ElastraX</h1>
  <p class="muted">Enter the admin token (<code>METRICS_AUTH_TOKEN</code>).</p>
  <label for="token">Token</label>
  <input id="token" name="token" type="password" required autofocus spellcheck="false">
  <button type="submit">Sign in</button>
  <p id="error" class="error" role="alert" hidden></p>
</form>
<script src="/admin/app.js"></script>
</body></html>`;

const STYLE_CSS = `:root{
  --bg:#0e1116; --panel:#161b22; --panel-2:#1c232d; --line:#2a313c;
  --fg:#e6edf3; --muted:#8b949e; --accent:#4c8dff; --good:#3fb950;
  --warn:#d29922; --bad:#f85149; --radius:10px;
}
@media (prefers-color-scheme: light){
  :root{ --bg:#f6f8fa; --panel:#fff; --panel-2:#f0f3f6; --line:#d0d7de;
         --fg:#1f2328; --muted:#59636e; }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.login-page{display:grid;place-items:center;min-height:100vh;padding:24px}
.login-card{width:min(420px,100%)}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:15px;margin:0 0 12px;letter-spacing:.02em}
.muted{color:var(--muted);margin:0 0 16px}
label{display:block;font-size:12px;color:var(--muted);margin:12px 0 4px}
input{width:100%;padding:9px 11px;border-radius:8px;border:1px solid var(--line);
  background:var(--panel-2);color:var(--fg);font:inherit}
button{margin-top:14px;padding:9px 14px;border-radius:8px;border:1px solid var(--line);
  background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:var(--panel-2);color:var(--fg)}
button:disabled{opacity:.5;cursor:progress}
.error{color:var(--bad);margin:12px 0 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:18px;margin-bottom:16px}
header.top{display:flex;align-items:center;gap:12px;padding:14px 20px;
  border-bottom:1px solid var(--line);background:var(--panel);
  position:sticky;top:0;z-index:5;flex-wrap:wrap}
header.top .spacer{flex:1}
nav{display:flex;gap:4px;flex-wrap:wrap;padding:12px 20px 0}
nav button{background:transparent;border:1px solid transparent;margin:0;padding:6px 11px;
  color:var(--muted);font-weight:500}
nav button[aria-selected="true"]{background:var(--panel-2);color:var(--fg);border-color:var(--line)}
main{padding:0 20px 32px;max-width:1400px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px}
.stat .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.stat .v{font-size:22px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums}
.stat .s{font-size:12px;color:var(--muted)}
.good{color:var(--good)} .warn{color:var(--warn)} .bad{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);
  position:sticky;top:0;background:var(--panel)}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.scroll{max-height:460px;overflow:auto;border:1px solid var(--line);border-radius:var(--radius)}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;
  border:1px solid var(--line);color:var(--muted)}
.tag.on{color:var(--good);border-color:var(--good)}
.tag.off{color:var(--bad);border-color:var(--bad)}
.row-actions{display:flex;gap:6px;flex-wrap:wrap}
.row-actions button{margin:0;padding:3px 9px;font-size:12px}
.bar{height:6px;border-radius:3px;background:var(--panel-2);overflow:hidden}
.bar>i{display:block;height:100%;background:var(--accent)}
.toast{position:fixed;right:16px;bottom:16px;padding:10px 14px;border-radius:8px;
  background:var(--panel);border:1px solid var(--line);max-width:380px;display:none;z-index:20}
.toast.show{display:block}
.toast.bad{border-color:var(--bad)}
`;

const APP_JS = `'use strict';
// CSRF token lives in memory only, never in storage.
let csrf = '';
let current = 'overview';

const el = (tag, attrs, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  // textContent everywhere: room names, error strings and feedback text all
  // originate from users, so innerHTML is never used.
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const num = n => (typeof n === 'number' ? n.toLocaleString() : (n ?? '—'));
const pct = n => (typeof n === 'number' ? (n * 100).toFixed(1) + '%' : '—');
// The stranded table lists received + processing + failed; the headline stat
// used to read only 'received', so a mailbox full of failed rows reported 0.
const strandedInbox = states => (states.received || 0) + (states.processing || 0) + (states.failed || 0);

async function api(path, options) {
  const opts = Object.assign({ credentials: 'same-origin' }, options || {});
  if (opts.method && opts.method !== 'GET') {
    opts.headers = Object.assign({ 'x-admin-csrf': csrf }, opts.headers || {});
    if (opts.body) opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch('/admin/' + path, opts);
  if (res.status === 401) {
    // login answers a wrong token with 401 + {error}; redirecting there was a
    // reload of the page the operator is already on, which destroyed the
    // message before it could be shown.
    if (String(path).indexOf('api/login') !== 0) { location.href = '/admin/login'; throw new Error('unauthorized'); }
  }
  const body = await res.json().catch(() => ({}));
  // Action failures answer { ok: false, message } (the ActionResult shape),
  // while request-level failures use { error }. Reading only error made every
  // rejected action toast a bare "HTTP 400" and threw away the operator-facing
  // reason ("Row 5 is pending; only failed or dead-lettered rows can be retried.",
  // "No outbox row with id 9.", ...).
  if (!res.ok) throw new Error(body.error || body.message || ('HTTP ' + res.status));
  return body;
}

function toast(message, bad) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(node._t);
  node._t = setTimeout(() => { node.className = 'toast'; }, 4000);
}

async function act(path, body, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    const result = await api(path, { method: 'POST', body: JSON.stringify(body || {}) });
    toast(result.message || 'Done');
    render();
  } catch (error) { toast(String(error.message || error), true); }
}

function stat(key, value, sub) {
  return el('div', { class: 'stat' },
    el('div', { class: 'k' }, key),
    el('div', { class: 'v' }, value),
    sub ? el('div', { class: 's' }, sub) : null);
}

function table(headers, rows) {
  return el('div', { class: 'scroll' },
    el('table', {},
      el('thead', {}, el('tr', {}, headers.map(h => el('th', {}, h)))),
      el('tbody', {}, rows.map(r => el('tr', {}, r.map(c =>
        el('td', { class: typeof c === 'number' ? 'num' : '' }, c)))))));
}

function card(title, ...body) {
  return el('section', { class: 'card' }, el('h2', {}, title), ...body);
}

const VIEWS = {
  async overview() {
    const d = await api('api/overview');
    const s = d.services || {};
    const unhealthy = Object.entries(s).filter(([, v]) => v.status !== 'healthy');
    return [
      el('div', { class: 'grid' },
        stat('Uptime', Math.round(d.uptimeSeconds / 60) + 'm', 'v' + d.version),
        stat('Messages', num(d.messages.received), num(d.messages.errors) + ' errors'),
        stat('LLM p95', num(d.llm && d.llm.durationP95) + 'ms', num(d.llm && d.llm.requests) + ' requests'),
        stat('Tokens', num(d.tokens && d.tokens.total), (d.tokens && d.tokens.models || []).length + ' models'),
        stat('Queue', num(d.queue && d.queue.totalPending), num(d.queue && d.queue.totalRunning) + ' running'),
        stat('Feedback', d.feedback.positive + ' / ' + d.feedback.negative,
          d.feedback.positive + d.feedback.negative > 0
            ? pct(d.feedback.positive / (d.feedback.positive + d.feedback.negative)) + ' positive'
            : 'no reactions yet')),
      card('Services', table(['Service', 'Status', 'Checked', 'Error'],
        Object.entries(s).map(([name, v]) => [
          name,
          el('span', { class: 'tag ' + (v.status === 'healthy' ? 'on' : 'off') }, v.status),
          new Date(v.lastChecked).toLocaleTimeString(),
          v.error ? v.error.slice(0, 80) : '—',
        ]))),
      card('Token spend by model', table(['Model', 'Prompt', 'Completion', 'Total'],
        ((d.tokens && d.tokens.models) || []).map(m => [m.model, num(m.prompt), num(m.completion), num(m.total)]))),
      unhealthy.length
        ? card('Attention', el('p', { class: 'bad' },
            unhealthy.length + ' service(s) reporting unhealthy: ' + unhealthy.map(([n]) => n).join(', ')))
        : null,
    ].filter(Boolean);
  },

  async tools() {
    const d = await api('api/tools');
    const rows = d.tools.map(t => [
      t.name,
      t.category,
      t.permission,
      el('span', { class: 'tag ' + (t.enabled ? 'on' : 'off') }, t.enabled ? 'on' : 'off'),
      num(t.invocations),
      num(t.errors),
      pct(t.errorRate),
      num(t.durationP50) + 'ms',
      el('span', { class: 'tag' }, t.aliases.join(' ') || '—'),
      t.alwaysLoad ? 'yes' : '',
    ]);
    return [
      card('Registry',
        el('p', { class: 'muted' },
          num(d.catalogSize) + ' tools · ' + d.alwaysLoaded.length + ' always loaded · ' +
          d.plugins.length + ' plugin report(s)')),
      card('Tools', table(['Name', 'Category', 'Permission', 'Enabled', 'Calls', 'Errors', 'Error rate', 'p50', 'Aliases', 'Always'], rows)),
      d.plugins.length ? card('Plugins', table(['Name', 'Version', 'Status', 'Tools', 'Reason'],
        d.plugins.map(p => [p.manifestName || '—', p.version || '—',
          el('span', { class: 'tag ' + (p.status === 'refused' ? 'off' : p.status === 'loaded' ? 'on' : '') }, p.status),
          p.tools.join(', ') || '—', p.reason || '—']))) : null,
      card('Actions', el('div', { class: 'row-actions' },
        el('button', { class: 'secondary', onclick: () => act('api/action/reload-registry', {}, 'Reload the tool registry? Any in-flight tool call is unaffected.') }, 'Reload registry'),
        el('button', { class: 'secondary', onclick: () => act('api/action/retention-report', {}) }, 'Retention status'))),
    ].filter(Boolean);
  },

  async rooms() {
    const d = await api('api/rooms');
    return [
      el('div', { class: 'grid' },
        stat('Rooms', num(d.total), 'canonical keys'),
        stat('Key coverage', d.keyStats && d.keyStats.coverageIsComplete === false ? 'incomplete' : 'complete',
          d.keyStats ? num(d.keyStats.roomKeys) + ' registered' : ''),
        stat('With knowledge', num(d.rooms.filter(r => r.knowledgeDocuments > 0).length), 'rooms indexed')),
      card('Rooms', table(['Room', 'Platform', 'Key', 'Documents', 'Reminders', 'Created'],
        d.rooms.map(r => [r.label, r.platform || '—', r.roomKey || '—', num(r.knowledgeDocuments), num(r.reminders), r.createdAt ? r.createdAt.slice(0, 19).replace('T', ' ') : '—']))),
    ];
  },

  async delivery() {
    const d = await api('api/delivery');
    const states = d.outbox.byState || {};
    return [
      el('div', { class: 'grid' },
        Object.entries(states).map(([k, v]) => stat(k, num(v), null)),
        stat('Inbox stranded', num(strandedInbox(d.inbox.byState || {})), 'no recovery scan exists')),
      card('Outbox — failed and dead-lettered', table(['ID', 'Platform', 'Room', 'State', 'Tries', 'Error', 'Body', ''],
        d.outbox.rows.map(r => [String(r.id), r.platform || '—', r.chatRoomId, r.state, num(r.attempts),
          r.lastError || '—', r.text || '—',
          el('button', { class: 'secondary', onclick: () => act('api/action/retry-outbox', { id: r.id }, 'Requeue outbox row ' + r.id + '? It will be delivered on the next tick.') }, 'Retry')]))),
      card('Inbox — not completed', table(['ID', 'Room', 'State', 'Tries', 'Error'],
        d.inbox.stranded.map(r => [String(r.id), r.chatRoomId, r.state, num(r.attempts), r.lastError || '—']))),
    ];
  },

  async reminders() {
    const d = await api('api/reminders');
    return [
      el('div', { class: 'grid' },
        stat('Pending', num(d.pending), 'reminders'),
        stat('Flow sessions', num(d.flows.total), d.flows.oldest ? 'oldest ' + d.flows.oldest.slice(0, 10) : '')),
      card('Pending reminders', table(['ID', 'Room', 'Message', 'Due', 'Recurrence'],
        d.rows.map(r => [String(r.id), r.room, r.message, r.remindAt.slice(0, 19).replace('T', ' '), r.recurrence || '—']))),
    ];
  },

  async roomkeys() {
    const d = await api('api/roomkeys');
    return [card('Canonical room keys (' + num(d.total) + ')',
      table(['Room key', 'Platform', 'Remote id', 'Legacy id', 'Created'],
        d.rows.map(r => [r.roomKey, r.platform, r.remoteRoomId, r.legacyRoomId || '—', (r.createdAt || '').slice(0, 19).replace('T', ' ')])))];
  },

  async feedback() {
    const d = await api('api/feedback');
    return [
      el('div', { class: 'grid' },
        stat('Positive', num(d.positive), null),
        stat('Negative', num(d.negative), null),
        stat('Ratio', d.ratio === null ? '—' : pct(d.ratio), 'positive share'),
        stat('Malformed lines', num(d.malformedLines), 'in the eval log')),
      d.truncated
        ? card('Note', el('p', { class: 'muted' }, 'Only the last 1 MiB of the feedback log was read; older reactions are not shown.'))
        : null,
      card('Recent reactions', table(['When', 'Platform', 'Room', 'Sentiment', 'Reaction', 'Retracted'],
        d.entries.map(e => [String(e.at).slice(0, 19).replace('T', ' '), e.platform, e.chatRoomId, e.sentiment, e.reaction, e.removed ? 'yes' : '']))),
    ].filter(Boolean);
  },

  async config() {
    const d = await api('api/config');
    return [
      d.missing.length ? card('Unset (' + d.missing.length + ')', el('p', { class: 'muted mono' }, d.missing.join('  '))) : null,
      card('Effective configuration', table(['Variable', 'Value'],
        d.keys.map(k => [k.name, k.secret ? el('span', { class: 'tag' }, k.value) : k.value]))),
    ].filter(Boolean);
  },
};

const TABS = [
  ['overview', 'Overview'], ['tools', 'Tools'], ['rooms', 'Rooms'],
  ['delivery', 'Delivery'], ['reminders', 'Reminders'],
  ['roomkeys', 'Room keys'], ['feedback', 'Feedback'], ['config', 'Config'],
];

async function render() {
  const main = document.getElementById('view');
  main.textContent = '';
  main.append(el('p', { class: 'muted' }, 'Loading…'));
  try {
    const nodes = await VIEWS[current]();
    main.textContent = '';
    for (const node of nodes) if (node) main.append(node);
  } catch (error) {
    main.textContent = '';
    main.append(el('p', { class: 'bad' }, String(error.message || error)));
  }
}

function boot() {
  if (document.getElementById('login')) {
    document.getElementById('login').addEventListener('submit', async event => {
      event.preventDefault();
      const errorNode = document.getElementById('error');
      const button = event.target.querySelector('button');
      button.disabled = true;
      try {
        await api('api/login', { method: 'POST', body: JSON.stringify({ token: document.getElementById('token').value }) });
        location.href = '/admin/';
      } catch (error) {
        errorNode.textContent = String(error.message || error);
        errorNode.hidden = false;
      } finally { button.disabled = false; }
    });
    return;
  }

  const nav = document.getElementById('tabs');
  for (const [key, label] of TABS) {
    const button = el('button', {
      role: 'tab',
      'aria-selected': key === current ? 'true' : 'false',
      onclick: () => {
        current = key;
        for (const other of nav.querySelectorAll('button')) other.setAttribute('aria-selected', 'false');
        button.setAttribute('aria-selected', 'true');
        render();
      },
    }, label);
    nav.append(button);
  }
  document.getElementById('signout').addEventListener('click', async () => {
    try { await api('api/logout', { method: 'POST' }); } finally { location.href = '/admin/login'; }
  });
  document.getElementById('refresh').addEventListener('click', render);

  api('api/session').then(s => { csrf = s.csrf; render(); }).catch(() => { location.href = '/admin/login'; });
}

document.addEventListener('DOMContentLoaded', boot);
`;

const APP_SHELL_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ElastraX admin</title><link rel="stylesheet" href="/admin/style.css"></head>
<body>
<header class="top">
  <strong>ElastraX</strong><span class="muted">admin</span>
  <span class="spacer"></span>
  <button id="refresh" class="secondary">Refresh</button>
  <button id="signout" class="secondary">Sign out</button>
</header>
<nav id="tabs" role="tablist"></nav>
<main id="view"></main>
<div id="toast" class="toast"></div>
<script src="/admin/app.js"></script>
</body></html>`;

export { APP_SHELL_HTML, APP_JS };
