/**
 * @file src/webhookServer.ts
 * @description Lightweight HTTP webhook server for inbound notifications.
 *
 * Exposes a single endpoint that external services can POST to in order to send
 * messages into any registered chat room. This turns ElastraX into a general-purpose
 * notification bus.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * CANONICAL REQUEST FORMAT (works with any HTTP client / service)
 * ═══════════════════════════════════════════════════════════════════════════════
 *   POST http://your-bot:3500/webhook
 *   Content-Type: application/json
 *
 *   {
 *     "room_id":  "120363xxxxxx@g.us",  // WhatsApp JID or Discord channel ID
 *     "text":     "Your message here",   // plain text or *bold* markdown
 *     "secret":   "your-webhook-secret"  // must match WEBHOOK_SECRET env var
 *   }
 *
 * Alternative: pass room_id and secret as query params:
 *   POST /webhook?room_id=120363xxxxxx@g.us&secret=xxx
 *   { "text": "message here" }
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * AUTO-DETECTED SERVICE ADAPTERS
 * ═══════════════════════════════════════════════════════════════════════════════
 * GitHub Actions / GitHub Webhooks (`X-GitHub-Event` header):
 *   Formats push, pull_request, issues, release, workflow_run events.
 *
 * Grafana Alerts (`X-Grafana-Origin: alertmanager` header):
 *   Formats firing / resolved alert messages.
 *
 * Generic JSON:
 *   Falls back to JSON.stringify of the body if no "text" field is found.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ENVIRONMENT VARIABLES
 * ═══════════════════════════════════════════════════════════════════════════════
 *   WEBHOOK_PORT    — Port to listen on (default: 3500)
 *   WEBHOOK_SECRET  — Shared secret for all webhook requests (required)
 *   WEBHOOK_ENABLED — Set to "false" to disable the webhook server (default: true)
 */

import { logger } from './utils/logger';
import { createHmac, timingSafeEqual } from 'crypto';
import { healthMetrics } from './utils/HealthMetrics';

const log = logger.child({ module: 'WebhookServer' });

type SendFn = (chatId: string, text: string, platform?: string) => Promise<void>;

type WebhookBody = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asWebhookBody(value: unknown): WebhookBody {
  return asRecord(value) ?? {};
}

function toObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => item !== null);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/[;,]/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  return [];
}

function uniqueStable(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizePriority(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === 'critical' || normalized === 'emergency') return 'critical';
  if (normalized === 'high' || normalized === 'warning' || normalized === 'warn') return 'high';
  if (normalized === 'low' || normalized === 'debug') return 'low';
  return 'normal';
}

function truncateText(text: string): string {
  const maxLength = Math.max(200, parseInt(process.env.WEBHOOK_MAX_TEXT_LENGTH || '3500', 10) || 3500);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function isValidPort(value: number): boolean {
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

// ─── Service Adapters ──────────────────────────────────────────────────────────

function adaptGitHub(event: string, body: WebhookBody): string {
  switch (event) {
    case 'push': {
      const branch = asNonEmptyString(body.ref)?.replace('refs/heads/', '') || '';
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || 'unknown';
      const commits = toObjectArray(body.commits).slice(0, 3);
      const commitLines = commits
        .map((commit) => {
          const message = asNonEmptyString(commit.message) || '(no message)';
          const id = asNonEmptyString(commit.id)?.slice(0, 7) || 'unknown';
          return `  • ${message.split('\n')[0]} (${id})`;
        })
        .join('\n');
      return `🔔 *GitHub Push*\n📦 Repo: ${repo}\n🌿 Branch: ${branch}\n📝 Commits:\n${commitLines || '  (no commits)'}`;
    }
    case 'pull_request': {
      const pr = asRecord(body.pull_request);
      const action = asNonEmptyString(body.action)?.toUpperCase() || 'UNKNOWN';
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || 'unknown';
      return `🔔 *GitHub PR ${action}*\n📦 ${repo}\n#${String(pr?.number ?? '?')} ${asNonEmptyString(pr?.title) || 'Untitled'}\n🔗 ${asNonEmptyString(pr?.html_url) || ''}`;
    }
    case 'issues': {
      const issue = asRecord(body.issue);
      const action = asNonEmptyString(body.action)?.toUpperCase() || 'UNKNOWN';
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || 'unknown';
      return `🔔 *GitHub Issue ${action}*\n📦 ${repo}\n#${String(issue?.number ?? '?')} ${asNonEmptyString(issue?.title) || 'Untitled'}\n🔗 ${asNonEmptyString(issue?.html_url) || ''}`;
    }
    case 'release': {
      const rel = asRecord(body.release);
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || 'unknown';
      return `🎉 *GitHub Release: ${asNonEmptyString(rel?.tag_name) || 'unknown'}*\n📦 ${repo}\n${asNonEmptyString(rel?.name) || ''}\n🔗 ${asNonEmptyString(rel?.html_url) || ''}`;
    }
    case 'workflow_run': {
      const wf = asRecord(body.workflow_run);
      const conclusion = asNonEmptyString(wf?.conclusion);
      const icon = conclusion === 'success' ? '✅' : conclusion === 'failure' ? '❌' : '⚙️';
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || 'unknown';
      return `${icon} *GitHub Workflow: ${asNonEmptyString(wf?.name) || 'unknown'}*\n📦 ${repo}\nStatus: ${asNonEmptyString(wf?.status) || 'unknown'} / ${conclusion || 'running'}\n🔗 ${asNonEmptyString(wf?.html_url) || ''}`;
    }
    default:
      return `🔔 *GitHub Event: ${event}*\n${JSON.stringify(body).slice(0, 200)}`;
  }
}

function adaptGrafana(body: WebhookBody): string {
  const alerts = toObjectArray(body.alerts);
  if (alerts.length === 0) return `🔔 *Grafana Alert*\n${JSON.stringify(body).slice(0, 300)}`;

  return alerts.map((alert) => {
    const labels = asRecord(alert.labels);
    const annotations = asRecord(alert.annotations);
    const status = asNonEmptyString(alert.status) || 'unknown';
    const icon = status === 'firing' ? '🔥' : '✅';
    const name = asNonEmptyString(labels?.alertname) || 'Unknown Alert';
    const summary = asNonEmptyString(annotations?.summary) || asNonEmptyString(annotations?.description) || '';
    return `${icon} *${name}* (${status.toUpperCase()})\n${summary}`.trim();
  }).join('\n\n');
}

function adaptApprise(body: WebhookBody): string {
  const title = asNonEmptyString(body.title) || asNonEmptyString(body.subject);
  const content = asNonEmptyString(body.body)
    || asNonEmptyString(body.message)
    || asNonEmptyString(body.text)
    || asNonEmptyString(body.msg)
    || '';
  const notifyType = asNonEmptyString(body.notify_type)
    || asNonEmptyString(body.type)
    || 'info';
  const tags = toStringArray(body.tag ?? body.tags);
  const source = asNonEmptyString(body.source)
    || asNonEmptyString(body.service)
    || asNonEmptyString(body.app)
    || null;
  const timestamp = asNonEmptyString(body.timestamp) || asNonEmptyString(body.ts);
  const link = asNonEmptyString(body.url) || asNonEmptyString(body.link);

  const icon = notifyType.toLowerCase() === 'success'
    ? '✅'
    : notifyType.toLowerCase() === 'warning'
      ? '⚠️'
      : (notifyType.toLowerCase() === 'failure' || notifyType.toLowerCase() === 'error')
        ? '❌'
        : notifyType.toLowerCase() === 'info'
          ? 'ℹ️'
          : '🔔';

  const lines = [
    `${icon} *${title || 'Apprise Notification'}*`,
    content || '(empty message body)',
  ];

  if (source) lines.push(`🧩 Source: ${source}`);
  if (tags.length > 0) lines.push(`🏷️ Tags: ${tags.join(', ')}`);
  if (timestamp) lines.push(`🕒 Time: ${timestamp}`);
  if (link) lines.push(`🔗 ${link}`);

  return lines.join('\n');
}

function buildGenericMessage(body: WebhookBody): string {
  const title = asNonEmptyString(body.title);
  const text = asNonEmptyString(body.text)
    || asNonEmptyString(body.message)
    || asNonEmptyString(body.body)
    || asNonEmptyString(body.description)
    || null;
  const source = asNonEmptyString(body.source) || asNonEmptyString(body.service);
  const event = asNonEmptyString(body.event) || asNonEmptyString(body.event_type);
  const level = normalizePriority(
    asNonEmptyString(body.priority)
    || asNonEmptyString(body.severity)
    || asNonEmptyString(body.level),
  );
  const tags = toStringArray(body.tags ?? body.tag);
  const link = asNonEmptyString(body.url) || asNonEmptyString(body.link);

  const icon = level === 'critical'
    ? '🚨'
    : level === 'high'
      ? '⚠️'
      : level === 'low'
        ? '🔎'
        : '📨';

  if (!title && !text && !source && !event && tags.length === 0 && !link) {
    return `📨 Webhook payload:\n${JSON.stringify(body, null, 2).slice(0, 500)}`;
  }

  const lines: string[] = [];
  if (title) {
    lines.push(`${icon} *${title}*`);
  } else if (event) {
    lines.push(`${icon} *${event}*`);
  }

  if (text) lines.push(text);
  if (source) lines.push(`🧩 Source: ${source}`);
  if (event && title) lines.push(`📌 Event: ${event}`);
  if (level) lines.push(`📊 Priority: ${level}`);
  if (tags.length > 0) lines.push(`🏷️ Tags: ${tags.join(', ')}`);
  if (link) lines.push(`🔗 ${link}`);

  return lines.join('\n');
}

function isApprisePayload(headers: Record<string, string | undefined>, body: WebhookBody): boolean {
  if (headers['x-apprise-notification-type']) return true;
  if (headers['x-apprise-title']) return true;

  if (body.notify_type !== undefined && body.notify_type !== null) return true;
  if (body.apprise !== undefined && body.apprise !== null) return true;

  const hasSubject = asNonEmptyString(body.subject) !== null;
  const hasBodyLikeText = asNonEmptyString(body.body)
    || asNonEmptyString(body.message)
    || asNonEmptyString(body.text);

  return hasSubject && hasBodyLikeText !== null;
}

export function buildWebhookMessage(headers: Record<string, string | undefined>, body: WebhookBody): string {
  // GitHub
  const githubEvent = headers['x-github-event'];
  if (githubEvent) return adaptGitHub(githubEvent, body);

  // Grafana
  const grafanaOrigin = headers['x-grafana-origin'];
  if (grafanaOrigin || body.alerts) return adaptGrafana(body);

  // Apprise-compatible payload
  if (isApprisePayload(headers, body)) return adaptApprise(body);

  // Rich generic payload
  return buildGenericMessage(body);
}

export function verifyGitHubSignature(payload: string, secret: string, signatureHeader: string | null): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signatureHeader);

  if (expectedBuf.length !== providedBuf.length) {
    // Perform a dummy comparison to maintain constant time
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Constant-time string comparison using crypto.timingSafeEqual to prevent
 * timing side-channel attacks on shared secret verification.
 */
function safeSecretCompare(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Compare with itself to consume constant time, then return false
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// ─── Server ────────────────────────────────────────────────────────────────────

export class WebhookServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private senders = new Map<string, SendFn>();

  /**
   * Register a send function for a platform.
   * The 'any' platform acts as a fallback that routes based on the room_id format.
   */
  registerSender(platform: string, fn: SendFn): void {
    this.senders.set(platform, fn);
  }

  /** Send to the appropriate platform based on room_id format heuristics. */
  private async send(roomId: string, text: string, platform?: string): Promise<void> {
    // If platform is explicitly given, use that sender
    if (platform && this.senders.has(platform)) {
      return this.senders.get(platform)!(roomId, text, platform);
    }

    // Auto-detect: WhatsApp JIDs contain @ followed by s.whatsapp.net or g.us
    if (roomId.includes('@g.us') || roomId.includes('@s.whatsapp.net')) {
      const wa = this.senders.get('whatsapp');
      if (wa) return wa(roomId, text);
    }

    // Numeric IDs without @ are likely Discord channel IDs
    if (/^\d+$/.test(roomId)) {
      const dc = this.senders.get('discord');
      if (dc) return dc(roomId, text);
    }

    // Fallback: try any registered sender
    const fallback = this.senders.values().next().value;
    if (fallback) return (fallback as SendFn)(roomId, text);

    throw new Error(`No sender available for room_id: ${roomId}`);
  }

  start(): void {
    const enabled = process.env.WEBHOOK_ENABLED !== 'false';
    if (!enabled) {
      log.info('Webhook server disabled via WEBHOOK_ENABLED=false');
      return;
    }

    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) {
      log.warn('WEBHOOK_SECRET not set — /webhook endpoint will be disabled, /health remains available');
    }

    const rawPort = process.env.WEBHOOK_PORT;
    const parsedPort = Number.parseInt((rawPort ?? '').trim(), 10);
    const port = resolveWebhookPort(rawPort);
    const maxBodyBytes = resolveWebhookMaxBodyBytes(process.env.WEBHOOK_MAX_BODY_BYTES);
    if (rawPort && rawPort.trim() !== '' && !isValidPort(parsedPort)) {
      log.warn({ rawPort, fallbackPort: port }, 'Invalid WEBHOOK_PORT value; falling back to default');
    }

    this.server = Bun.serve({
      port,
      fetch: async (req) => {
        // Only accept POST /webhook
        const url = new URL(req.url);
        log.trace({ method: req.method, pathname: url.pathname }, 'HTTP request received');
        if (req.method !== 'POST' || !url.pathname.startsWith('/webhook')) {
          // Health check endpoint
          if (req.method === 'GET' && url.pathname === '/health') {
            const metrics = healthMetrics.getMetrics();
            return new Response(JSON.stringify({ status: 'ok', ...metrics }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          // Prometheus-compatible metrics endpoint
          if (req.method === 'GET' && url.pathname === '/metrics') {
            return new Response(healthMetrics.getPrometheusMetrics(), {
              headers: { 'Content-Type': 'text/plain; version=0.0.4' },
            });
          }
          return new Response('Not Found', { status: 404 });
        }

        if (!secret) {
          return new Response(JSON.stringify({ error: 'Webhook is disabled because WEBHOOK_SECRET is not configured.' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        let bodyRaw = '';
        let body: WebhookBody = {};
        try {
          bodyRaw = await readRequestBodyWithLimit(req, maxBodyBytes);
          body = bodyRaw ? asWebhookBody(JSON.parse(bodyRaw)) : {};
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Invalid JSON body';
          const status = message.includes('Request body too large') ? 413 : 400;
          return new Response(JSON.stringify({ error: message }), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const githubEvent = req.headers.get('x-github-event');
        if (githubEvent) {
          const sigHeader = req.headers.get('x-hub-signature-256');
          if (!verifyGitHubSignature(bodyRaw, secret, sigHeader)) {
            return new Response(JSON.stringify({ error: 'Invalid GitHub signature' }), {
              status: 401, headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        // Non-GitHub sources use shared secret with constant-time comparison
        if (!githubEvent) {
          const providedSecret = asNonEmptyString(body.secret)
            || asNonEmptyString(url.searchParams.get('secret'))
            || asNonEmptyString(req.headers.get('x-webhook-secret'))
            || '';
          if (!safeSecretCompare(providedSecret, secret)) {
            return new Response(JSON.stringify({ error: 'Invalid or missing secret' }), {
              status: 401, headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        const roomIds = resolveRoomIds(body, url);
        if (roomIds.length === 0) {
          return new Response(JSON.stringify({ error: 'room_id (or room_ids) is required' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }

        // Build the headers map for adapter detection (lowercase keys)
        const headers: Record<string, string | undefined> = {};
        req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

        const text = truncateText(buildWebhookMessage(headers, body));
        const platform = asNonEmptyString(body.platform) || undefined;

        try {
          const deliveryResults = await Promise.allSettled(
            roomIds.map((roomId) => this.send(roomId, text, platform)),
          );

          const failed: Array<{ roomId: string; error: string }> = [];
          for (let i = 0; i < deliveryResults.length; i++) {
            const result = deliveryResults[i];
            if (result.status === 'rejected') {
              const errorMessage = result.reason instanceof Error
                ? result.reason.message
                : String(result.reason || 'Unknown error');
              failed.push({ roomId: roomIds[i], error: errorMessage });
            }
          }

          const delivered = roomIds.length - failed.length;
          log.info(
            {
              roomIds,
              delivered,
              failed: failed.length,
              source: headers['x-github-event'] || headers['x-grafana-origin'] || (isApprisePayload(headers, body) ? 'apprise' : 'generic'),
            },
            'Webhook message delivery completed',
          );

          if (failed.length > 0) {
            return new Response(JSON.stringify({ ok: false, delivered, failed }), {
              status: 207,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          log.error({ err, roomIds }, 'Failed to deliver webhook message');
          return new Response(JSON.stringify({ error: message }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    log.info({ port }, 'Webhook server started');
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }
}
