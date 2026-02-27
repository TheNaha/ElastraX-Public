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

type SendFn = (chatId: string, text: string, platform?: string) => Promise<void>;

// ─── Service Adapters ──────────────────────────────────────────────────────────

function adaptGitHub(event: string, body: any): string {
  switch (event) {
    case 'push': {
      const branch = (body.ref || '').replace('refs/heads/', '');
      const repo = body.repository?.full_name || 'unknown';
      const commits = (body.commits || []).slice(0, 3);
      const commitLines = commits.map((c: any) => `  • ${c.message?.split('\n')[0]} (${c.id?.slice(0, 7)})`).join('\n');
      return `🔔 *GitHub Push*\n📦 Repo: ${repo}\n🌿 Branch: ${branch}\n📝 Commits:\n${commitLines || '  (no commits)'}`;
    }
    case 'pull_request': {
      const pr = body.pull_request;
      const action = body.action;
      return `🔔 *GitHub PR ${action?.toUpperCase()}*\n📦 ${body.repository?.full_name}\n#${pr?.number} ${pr?.title}\n🔗 ${pr?.html_url}`;
    }
    case 'issues': {
      const issue = body.issue;
      return `🔔 *GitHub Issue ${body.action?.toUpperCase()}*\n📦 ${body.repository?.full_name}\n#${issue?.number} ${issue?.title}\n🔗 ${issue?.html_url}`;
    }
    case 'release': {
      const rel = body.release;
      return `🎉 *GitHub Release: ${rel?.tag_name}*\n📦 ${body.repository?.full_name}\n${rel?.name || ''}\n🔗 ${rel?.html_url}`;
    }
    case 'workflow_run': {
      const wf = body.workflow_run;
      const icon = wf?.conclusion === 'success' ? '✅' : wf?.conclusion === 'failure' ? '❌' : '⚙️';
      return `${icon} *GitHub Workflow: ${wf?.name}*\n📦 ${body.repository?.full_name}\nStatus: ${wf?.status} / ${wf?.conclusion || 'running'}\n🔗 ${wf?.html_url}`;
    }
    default:
      return `🔔 *GitHub Event: ${event}*\n${JSON.stringify(body).slice(0, 200)}`;
  }
}

function adaptGrafana(body: any): string {
  const alerts = body.alerts || [];
  if (alerts.length === 0) return `🔔 *Grafana Alert*\n${JSON.stringify(body).slice(0, 300)}`;

  return alerts.map((a: any) => {
    const icon = a.status === 'firing' ? '🔥' : '✅';
    const name = a.labels?.alertname || 'Unknown Alert';
    const summary = a.annotations?.summary || a.annotations?.description || '';
    return `${icon} *${name}* (${a.status?.toUpperCase()})\n${summary}`.trim();
  }).join('\n\n');
}

function buildMessage(headers: Record<string, string | undefined>, body: any): string {
  // GitHub
  const githubEvent = headers['x-github-event'];
  if (githubEvent) return adaptGitHub(githubEvent, body);

  // Grafana
  const grafanaOrigin = headers['x-grafana-origin'];
  if (grafanaOrigin || body.alerts) return adaptGrafana(body);

  // Canonical / Generic
  if (typeof body.text === 'string' && body.text) return body.text;
  if (typeof body.message === 'string' && body.message) return body.message;

  // Last resort: stringify the body
  return `📨 Webhook payload:\n${JSON.stringify(body, null, 2).slice(0, 500)}`;
}

function verifyGitHubSignature(payload: string, secret: string, signatureHeader: string | null): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
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
      logger.info('[WebhookServer] Disabled via WEBHOOK_ENABLED=false');
      return;
    }

    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) {
      logger.warn('[WebhookServer] WEBHOOK_SECRET not set — /webhook endpoint will be disabled, /health remains available.');
    }

    const port = parseInt(process.env.WEBHOOK_PORT || '3500', 10);

    this.server = Bun.serve({
      port,
      fetch: async (req) => {
        // Only accept POST /webhook
        const url = new URL(req.url);
        if (req.method !== 'POST' || !url.pathname.startsWith('/webhook')) {
          // Health check endpoint
          if (req.method === 'GET' && url.pathname === '/health') {
            return new Response(JSON.stringify({ status: 'ok', uptime: process.uptime() }), {
              headers: { 'Content-Type': 'application/json' },
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
        let body: any = {};
        try {
          bodyRaw = await req.text();
          body = bodyRaw ? JSON.parse(bodyRaw) : {};
        } catch {
          return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
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

        // Non-GitHub sources use shared secret: body > query param > header
        if (!githubEvent) {
          const bodySecret = body.secret || url.searchParams.get('secret') || req.headers.get('x-webhook-secret') || '';
          if (bodySecret !== secret) {
            return new Response(JSON.stringify({ error: 'Invalid or missing secret' }), {
              status: 401, headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        // Resolve room_id: body > query param
        const roomId = String(body.room_id || url.searchParams.get('room_id') || '').trim();
        if (!roomId) {
          return new Response(JSON.stringify({ error: 'room_id is required' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }

        // Build the headers map for adapter detection (lowercase keys)
        const headers: Record<string, string | undefined> = {};
        req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

        const text = buildMessage(headers, body);
        const platform = body.platform as string | undefined;

        try {
          await this.send(roomId, text, platform);
          logger.info({ roomId, source: headers['x-github-event'] || headers['x-grafana-origin'] || 'generic' }, '[WebhookServer] Message delivered');
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err: any) {
          logger.error({ err, roomId }, '[WebhookServer] Failed to deliver message');
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    });

    logger.info({ port }, '[WebhookServer] Started');
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }
}
