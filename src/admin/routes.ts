/**
 * @file src/admin/routes.ts
 * @description HTTP routing for the admin dashboard.
 *
 * Mounted into the existing WebhookServer at `/admin/*` rather than given its own
 * port, so all of this lives in one place and `WebhookServer` only grows a
 * single delegation branch.
 *
 * Security posture, since this shares a port with webhook intake:
 *  - disabled entirely unless `METRICS_AUTH_TOKEN` is a 16+ character secret
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

const log = logger.child({ module: 'AdminRoutes' });

/** Only these verbs are ever accepted. */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

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
    log.warn('[Admin] Dashboard disabled: set METRICS_AUTH_TOKEN (16+ characters) to enable it');
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

    const expectedHost = typeof server === 'object' && server !== null && 'hostname' in server
      ? String((server as { hostname: unknown }).hostname)
      : url.host;

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
      if (!isSameOrigin(req, expectedHost)) return json({ error: 'Forbidden' }, 403);
      if (!throttle.attempt(ip, now())) {
        return json({ error: 'Too many login attempts. Try again shortly.' }, 429, { 'Retry-After': '60' });
      }
      let presented = '';
      try {
        const body = await req.json() as { token?: unknown };
        presented = typeof body?.token === 'string' ? body.token : '';
      } catch {
        return json({ error: 'Expected a JSON body with a token.' }, 400);
      }
      const session = auth.login(presented, now());
      if (!session) return json({ error: 'Invalid token.' }, 401);
      return json({ ok: true, csrf: session.csrf }, 200, { 'Set-Cookie': auth.buildCookie(session.cookieValue) });
    }

    if (path === 'api/logout') {
      if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, { Allow: 'POST' });
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
      if (!isSameOrigin(req, expectedHost)) return json({ error: 'Forbidden' }, 403);
      const csrf = req.headers.get(ADMIN_CSRF_HEADER);
      if (!auth.verifyCsrf(cookie, csrf, now())) return json({ error: 'Invalid CSRF token' }, 403);
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

async function handleAction(req: Request, path: string, url: URL): Promise<Response> {
  let params: Record<string, unknown> = {};
  try {
    params = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  let result: ActionResult;
  switch (path) {
    case 'api/action/reload-registry':
      result = await actionReloadRegistry();
      break;
    case 'api/action/retry-outbox':
      result = await actionRetryOutbox(String(params.id ?? url.searchParams.get('id') ?? ''));
      break;
    case 'api/action/delete-knowledge':
      result = await actionDeleteKnowledge(
        String(params.roomKey ?? ''),
        typeof params.documentId === 'string' ? params.documentId : undefined,
      );
      break;
    case 'api/action/retention-report':
      result = actionRetentionReport();
      break;
    default:
      return json({ error: 'Not Found' }, 404);
  }
  return json(result, result.ok ? 200 : 400);
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

async function api(path, options) {
  const opts = Object.assign({ credentials: 'same-origin' }, options || {});
  if (opts.method && opts.method !== 'GET') {
    opts.headers = Object.assign({ 'x-admin-csrf': csrf }, opts.headers || {});
    if (opts.body) opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch('/admin/' + path, opts);
  if (res.status === 401) { location.href = '/admin/login'; throw new Error('unauthorized'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
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
        stat('Inbox stranded', num((d.inbox.byState || {}).received || 0), 'no recovery scan exists')),
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
      card('Recent reactions', table(['When', 'Platform', 'Room', 'Sentiment', 'Reaction', 'Retracted'],
        d.entries.map(e => [String(e.at).slice(0, 19).replace('T', ' '), e.platform, e.chatRoomId, e.sentiment, e.reaction, e.removed ? 'yes' : '']))),
    ];
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

export { APP_SHELL_HTML };
