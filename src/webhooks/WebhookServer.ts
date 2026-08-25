import { logger } from '../utils/logger';
import { healthMetrics } from '../utils/HealthMetrics';
import { ServiceBindingService } from '../utils/ServiceBindingService';
import { NotificationSubscriptionService } from '../utils/NotificationSubscriptionService';

import type { SendFn, WebhookBody } from './types';
import {
  asNonEmptyString,
  asRecord,
  asWebhookBody,
  isValidPort,
  mergeBindings,
  readRequestBodyWithLimit,
  resolveRoomIds,
  resolveWebhookMaxBodyBytes,
  resolveWebhookPort,
  safeSecretCompare,
  truncateText,
  verifyGitHubSignature,
} from './utils';

import { adaptJellyfin, adaptSeerr, buildWebhookMessage } from './adapters';

const log = logger.child({ module: 'WebhookServer' });

export class WebhookServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private senders = new Map<string, SendFn>();

  registerSender(platform: string, fn: SendFn): void {
    this.senders.set(platform, fn);
  }

  private async withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async send(roomId: string, text: string, platform?: string): Promise<void> {
    const SEND_TIMEOUT_MS = 15000;
    const deliver = (name: string, fn: SendFn) =>
      this.withTimeout(fn(roomId, text, name), SEND_TIMEOUT_MS, `webhook:${name}`);

    if (platform && this.senders.has(platform)) {
      return deliver(platform, this.senders.get(platform)!);
    }

    if (roomId.includes('@g.us') || roomId.includes('@s.whatsapp.net')) {
      const wa = this.senders.get('whatsapp');
      if (wa) return deliver('whatsapp', wa);
    }

    if (/^\d+$/.test(roomId)) {
      const dc = this.senders.get('discord');
      if (dc) return deliver('discord', dc);
    }

    // Prefer an explicit 'whatsapp' sender; otherwise fall back to the first registered.
    const fallbackName = this.senders.has('whatsapp') ? 'whatsapp' : this.senders.keys().next().value;
    if (fallbackName) return deliver(fallbackName, this.senders.get(fallbackName)!);

    throw new Error(`No sender available for room_id: ${roomId}`);
  }

  private async handleMediaWebhook(
    pathname: string,
    body: WebhookBody,
    url: URL,
    req: Request,
    ip: string,
  ): Promise<Response> {
    const isSeerr = pathname === '/webhook/seerr';
    const serviceType = isSeerr ? 'seerr' : 'jellyfin';

    const notificationType = asNonEmptyString(body.notification_type as string)
      ?? asNonEmptyString(body.NotificationType as string)
      ?? 'unknown';
    log.info({ serviceType, ip, notificationType, pathname }, 'Media webhook received');

    const serviceSecret = isSeerr
      ? process.env.SEERR_WEBHOOK_SECRET
      : process.env.JELLYFIN_WEBHOOK_SECRET;

    if (serviceSecret) {
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

    const formatted = isSeerr ? adaptSeerr(body) : adaptJellyfin(body);
    if (formatted === null) {
      log.debug({ serviceType, notificationType }, 'Dropping unactionable notification type (Unknown)');
      return new Response(JSON.stringify({ ok: true, delivered: 0, note: 'Dropped: unactionable notification type' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const text = truncateText(formatted);

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
      const jellyfinUserId = asNonEmptyString(body.UserId);
      const jellyfinUsername = asNonEmptyString(body.NotificationUsername);

      const [userBindings, usernameBindings] = await Promise.all([
        jellyfinUserId ? ServiceBindingService.findByExternalUser('jellyfin', jellyfinUserId) : Promise.resolve([]),
        jellyfinUsername ? ServiceBindingService.findByExternalUsername('jellyfin', jellyfinUsername) : Promise.resolve([]),
      ]);

      await addBindingTargets(mergeBindings(userBindings, usernameBindings));
    }

    const adminRooms = await NotificationSubscriptionService.getAdminNotificationRooms(serviceType);
    for (const room of adminRooms) addTarget(room.chatRoomId, room.platform);

    if (targets.length === 0) {
      log.info({ serviceType, ip, notificationType, pathname }, 'Media webhook received but no subscribers found — link an account with /connect and enable notifications');
      return new Response(JSON.stringify({ ok: true, delivered: 0, note: 'No subscribers' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

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
      error(error) {
        log.error({ err: error }, 'Unhandled webhook server error');
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      fetch: async (req, server) => {
        const url = new URL(req.url);
        const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
          ?? server.requestIP(req)?.address
          ?? 'unknown';
        log.debug({ method: req.method, pathname: url.pathname, ip }, 'HTTP request received');
        if (req.method !== 'POST' || !url.pathname.startsWith('/webhook')) {
          if (req.method === 'GET' && url.pathname === '/health') {
            const metrics = healthMetrics.getMetrics();
            const providerStatus = metrics.llm ? { providers: metrics.llm.requests > 0 ? 'checked' : 'idle' } : { providers: 'unknown' };
            return new Response(JSON.stringify({ status: 'ok', ...metrics, integration: providerStatus }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (req.method === 'GET' && url.pathname === '/metrics') {
            return new Response(healthMetrics.getPrometheusMetrics(), {
              headers: { 'Content-Type': 'text/plain; version=0.0.4' },
            });
          }
          return new Response('Not Found', { status: 404 });
        }

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

        if (isMediaWebhook) {
          return this.handleMediaWebhook(url.pathname, body, url, req, ip);
        }

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

        if (!githubEvent) {
          const providedSecret = asNonEmptyString(body.secret)
            || asNonEmptyString(url.searchParams.get('secret'));
          if (!providedSecret || !safeSecretCompare(providedSecret, resolvedSecret)) {
            return new Response(JSON.stringify({ error: 'Invalid or missing secret' }), {
              status: 401, headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        const roomIds = resolveRoomIds(body, url);
        if (roomIds.length === 0) {
          return new Response(JSON.stringify({ error: 'Missing room_id' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }

        const textBody = asNonEmptyString(body.text);
        const headersRecord: Record<string, string | undefined> = {};
        for (const [key, value] of req.headers.entries()) {
          headersRecord[key.toLowerCase()] = value;
        }

        let formattedText = '';
        if (!githubEvent && textBody) {
          formattedText = truncateText(textBody);
        } else {
          formattedText = truncateText(buildWebhookMessage(headersRecord, body));
        }

        const deliveryResults = await Promise.allSettled(
          roomIds.map((rid) => this.send(rid, formattedText)),
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
        if (failed.length > 0) {
          log.warn({ failed, delivered }, 'Partial generic webhook delivery failure');
          return new Response(JSON.stringify({ ok: false, delivered, failed }), {
            status: 207, headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ ok: true, delivered }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    log.info(`Webhook server running on port ${port}`);
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
      log.info('Webhook server stopped');
    }
  }
}
