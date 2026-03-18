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
import { ServiceBindingService } from './utils/ServiceBindingService';
import { NotificationSubscriptionService } from './utils/NotificationSubscriptionService';
import { getWebhookMaxTextLength } from './config/runtime';

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
  const maxLength = Math.max(200, getWebhookMaxTextLength());
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function mergeBindings<T extends { id: number }>(...bindingGroups: T[][]): T[] {
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

// ─── Media Service Adapters (V7.15) ────────────────────────────────────────────

export function adaptSeerr(body: WebhookBody): string {
  const notifType = asNonEmptyString(body.notification_type) ?? 'UNKNOWN';
  const subject = asNonEmptyString(body.subject) ?? '';
  const message = asNonEmptyString(body.message) ?? '';
  switch (notifType) {
    case 'MEDIA_PENDING':
      return `🎬 *New Request* — ${subject}\n${message}`.trim();
    case 'MEDIA_APPROVED':
      return `✅ *Request Approved* — ${subject}\n${message}`.trim();
    case 'MEDIA_AUTO_APPROVED':
      return `✅ *Auto-Approved* — ${subject}\n${message}`.trim();
    case 'MEDIA_AVAILABLE':
      return `🎉 *Now Available!* — ${subject}\n${message}`.trim();
    case 'MEDIA_DECLINED':
      return `❌ *Request Declined* — ${subject}\n${message}`.trim();
    case 'MEDIA_FAILED':
      return `⚠️ *Request Failed* — ${subject}\n${message}`.trim();
    case 'ISSUE_CREATED':
      return `🐛 *Issue Reported* — ${subject}\n${message}`.trim();
    case 'ISSUE_RESOLVED':
      return `✅ *Issue Resolved* — ${subject}`.trim();
    case 'ISSUE_COMMENT': {
      const comment = asNonEmptyString(body.comment_message) ?? message;
      return `💬 *New Comment* on ${subject}\n${comment}`.trim();
    }
    case 'TEST_NOTIFICATION':
      return '🔔 Request service notification test successful!';
    default:
      return `🔔 *Media Update (${notifType})* — ${subject}\n${message}`.trim();
  }
}

export function adaptJellyfin(body: WebhookBody): string | null {
  const notifType = asNonEmptyString(body.NotificationType) ?? 'Unknown';

  // Jellyfin sends "Unknown" for internal system events that don't map to a
  // real notification type. Silently drop them — they have no useful content.
  if (notifType === 'Unknown' || notifType === 'UNKNOWN') return null;
  const name = asNonEmptyString(body.Name) ?? 'Unknown';
  const overview = asNonEmptyString(body.Overview) ?? '';
  const year = asNonEmptyString(body.Year) ?? '';
  const seriesName = asNonEmptyString(body.SeriesName);
  const seasonNum = asNonEmptyString(body.SeasonNumber00);
  const episodeNum = asNonEmptyString(body.EpisodeNumber00);
  const username = asNonEmptyString(body.NotificationUsername) ?? '';
  const deviceName = asNonEmptyString(body.DeviceName) ?? '';
  // Build display title
  let displayName = name;
  if (seriesName) {
    displayName = `${seriesName}`;
    if (seasonNum && episodeNum) displayName += ` S${seasonNum}E${episodeNum}`;
    displayName += ` — ${name}`;
  }
  const yearStr = year ? ` (${year})` : '';

  switch (notifType) {
    case 'ItemAdded':
      return `📥 *New Media Added* — ${displayName}${yearStr}\n${overview}`.trim();
    case 'ItemDeleted':
      return `🗑️ *Media Removed* — ${displayName}${yearStr}`;
    case 'PlaybackStart':
      return `▶️ *Now Playing* — ${displayName}\nUser: ${username}\nDevice: ${deviceName}`;
    case 'PlaybackStop':
      return `⏹️ *Stopped Playing* — ${displayName}\nUser: ${username}`;
    case 'UserCreated':
      return `👤 *New User Created* — ${username}`;
    case 'AuthenticationFailure':
      return `🔒 *Auth Failure* — User: ${username}`;
    case 'PendingRestart':
      return '🔄 *Server Pending Restart*';
    case 'TaskCompleted': {
      const taskName = asNonEmptyString(body.TaskName) ?? 'Unknown Task';
      return `✅ *Task Completed* — ${taskName}`;
    }
    case 'PluginInstalled':
      return `🔌 *Plugin Installed* — ${name}`;
    default:
      return `🔔 *Streaming Service (${notifType})* — ${displayName}${yearStr}`;
  }
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

  /** Handle Seerr/Jellyfin webhook: authenticate, format, route to subscribers. */
  private async handleMediaWebhook(
    pathname: string,
    body: WebhookBody,
    url: URL,
    req: Request,
    ip: string,
  ): Promise<Response> {
    const isSeerr = pathname === '/webhook/seerr';
    const serviceType = isSeerr ? 'seerr' : 'jellyfin';

    // Log every inbound media webhook so auth/routing issues are easy to diagnose.
    const notificationType = asNonEmptyString(body.notification_type as string)   // Seerr
      ?? asNonEmptyString(body.NotificationType as string)                         // Jellyfin
      ?? 'unknown';
    log.info({ serviceType, ip, notificationType, pathname }, 'Media webhook received');

    // Per-service auth, independent of the global WEBHOOK_SECRET.
    // If the service secret is not configured the endpoint is unauthenticated —
    // rely on network-level security in that case.
    // Jellyfin's webhook plugin has no native secret field, so leave
    // JELLYFIN_WEBHOOK_SECRET unset to allow it through without a secret.
    // Seerr: set a token in Jellyseerr webhook settings → Authorization: Bearer
    const serviceSecret = isSeerr
      ? process.env.SEERR_WEBHOOK_SECRET
      : process.env.JELLYFIN_WEBHOOK_SECRET;

    if (serviceSecret) {
      // Seerr sends Authorization: Bearer <token> when configured in its webhook settings.
      // Also accept x-webhook-secret header, ?secret= query param, or body.secret as fallbacks.
      const authHeader = req.headers.get('authorization');
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      const providedSecret = bearerToken
        || asNonEmptyString(req.headers.get('x-webhook-secret'))
        || asNonEmptyString(url.searchParams.get('secret'))
        || asNonEmptyString(body.secret as string)
        || '';
      if (!safeSecretCompare(providedSecret, serviceSecret)) {
        log.warn({
          serviceType,
          ip,
          notificationType,
          // Show which auth methods were attempted (values are NOT logged for security)
          tried: {
            bearerHeader: bearerToken !== null,
            xWebhookSecretHeader: req.headers.get('x-webhook-secret') !== null,
            queryParam: url.searchParams.has('secret'),
            bodyField: body.secret !== undefined,
          },
        }, 'Media webhook rejected — invalid or missing secret');
        return new Response(JSON.stringify({ error: 'Invalid or missing secret' }), {
          status: 401, headers: { 'Content-Type': 'application/json' },
        });
      }
      log.debug({ serviceType, ip, authMethod: bearerToken ? 'bearer' : 'other' }, 'Media webhook auth passed');
    } else {
      log.debug({ serviceType, ip }, `No webhook secret configured for ${serviceType} — accepting request without auth`);
    }

    // Format the notification message
    const formatted = isSeerr ? adaptSeerr(body) : adaptJellyfin(body);
    if (formatted === null) {
      log.debug({ serviceType, notificationType }, 'Dropping unactionable notification type (Unknown)');
      return new Response(JSON.stringify({ ok: true, delivered: 0, note: 'Dropped: unactionable notification type' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const text = truncateText(formatted);

    // Resolve which users/rooms to notify
    const targets: { chatRoomId: string; platform: string }[] = [];
    const seen = new Set<string>();

    const addTarget = (chatRoomId: string, platform: string) => {
      const key = `${chatRoomId}:${platform}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ chatRoomId, platform });
      }
    };

    const addBindingTargets = async (bindings: Array<{ userId: string; platform: string }>) => {
      const roomGroups = await Promise.all(
        bindings.map((binding) =>
          NotificationSubscriptionService.getNotificationRooms(binding.userId, binding.platform, serviceType),
        ),
      );

      for (const rooms of roomGroups) {
        for (const room of rooms) {
          addTarget(room.chatRoomId, room.platform);
        }
      }
    };

    // 1. Route to the specific user who triggered the event
    if (isSeerr) {
      const extra = asRecord(body.extra) ?? {};
      const username = asNonEmptyString(body.requestedBy_username)
        ?? asNonEmptyString(extra.requestedBy_username as string);
      const email = asNonEmptyString(body.requestedBy_email)
        ?? asNonEmptyString(extra.requestedBy_email as string);

      const [usernameBindings, emailBindings] = await Promise.all([
        username ? ServiceBindingService.findByExternalUsername('seerr', username) : Promise.resolve([]),
        email ? ServiceBindingService.findByExternalEmail('seerr', email) : Promise.resolve([]),
      ]);

      await addBindingTargets(mergeBindings(usernameBindings, emailBindings));
    } else {
      // Jellyfin: lookup by UserId or NotificationUsername
      const jellyfinUserId = asNonEmptyString(body.UserId);
      const jellyfinUsername = asNonEmptyString(body.NotificationUsername);

      const [userBindings, usernameBindings] = await Promise.all([
        jellyfinUserId ? ServiceBindingService.findByExternalUser('jellyfin', jellyfinUserId) : Promise.resolve([]),
        jellyfinUsername ? ServiceBindingService.findByExternalUsername('jellyfin', jellyfinUsername) : Promise.resolve([]),
      ]);

      await addBindingTargets(mergeBindings(userBindings, usernameBindings));
    }

    // 2. Admin routing: Jellyfin admins get ALL notifications
    const adminRooms = await NotificationSubscriptionService.getAdminNotificationRooms(serviceType);
    for (const room of adminRooms) addTarget(room.chatRoomId, room.platform);

    if (targets.length === 0) {
      log.info({ serviceType, ip, notificationType, pathname }, 'Media webhook received but no subscribers found — link an account with /connect and enable notifications');
      return new Response(JSON.stringify({ ok: true, delivered: 0, note: 'No subscribers' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Deliver to all target rooms
    const deliveryResults = await Promise.allSettled(
      targets.map(({ chatRoomId, platform }) => this.send(chatRoomId, text, platform)),
    );

    const failed: Array<{ roomId: string; error: string }> = [];
    for (let i = 0; i < deliveryResults.length; i++) {
      const result = deliveryResults[i];
      if (result.status === 'rejected') {
        const errorMessage = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason || 'Unknown error');
        failed.push({ roomId: targets[i].chatRoomId, error: errorMessage });
      }
    }

    const delivered = targets.length - failed.length;
    log.info({ serviceType, ip, notificationType, delivered, failed: failed.length, targets: targets.length }, 'Media webhook delivery completed');

    if (failed.length > 0) {
      return new Response(JSON.stringify({ ok: false, delivered, failed }), {
        status: 207, headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true, delivered }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  start(): void {
    const enabled = process.env.WEBHOOK_ENABLED !== 'false';
    if (!enabled) {
      log.info('Webhook server disabled via WEBHOOK_ENABLED=false');
      return;
    }

    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) {
      log.warn('WEBHOOK_SECRET not set — generic /webhook endpoint will be disabled; /webhook/seerr and /webhook/jellyfin remain available with their own per-service secrets (SEERR_WEBHOOK_SECRET / JELLYFIN_WEBHOOK_SECRET)');
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
      fetch: async (req, server) => {
        const url = new URL(req.url);
        // Prefer X-Forwarded-For (reverse proxy) then fall back to the direct socket address
        const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
          ?? server.requestIP(req)?.address
          ?? 'unknown';
        log.debug({ method: req.method, pathname: url.pathname, ip }, 'HTTP request received');
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

        // Media webhooks have their own per-service secrets — allow them even without global WEBHOOK_SECRET
        const isMediaWebhook = url.pathname === '/webhook/seerr' || url.pathname === '/webhook/jellyfin';

        if (!secret && !isMediaWebhook) {
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
          log.warn({ ip, pathname: url.pathname, status, message }, 'Webhook body parse error');
          return new Response(JSON.stringify({ error: message }), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // ── Media Service Webhooks (V7.15) ──────────────────────────────────
        if (isMediaWebhook) {
          return this.handleMediaWebhook(url.pathname, body, url, req, ip);
        }

        // From here on, isMediaWebhook is false, so secret is guaranteed defined
        // (the !secret && !isMediaWebhook guard above would have returned 503 otherwise).
        const resolvedSecret = secret as string;

        const githubEvent = req.headers.get('x-github-event');
        if (githubEvent) {
          const sigHeader = req.headers.get('x-hub-signature-256');
          if (!verifyGitHubSignature(bodyRaw, resolvedSecret, sigHeader)) {
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
          if (!safeSecretCompare(providedSecret, resolvedSecret)) {
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
