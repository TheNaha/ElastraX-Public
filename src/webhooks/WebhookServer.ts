import { logger } from '../utils/logger';
import { healthMetrics } from '../utils/HealthMetrics';
import { isSupportedPlatform } from '../core/platforms';
import { ServiceBindingService } from '../utils/ServiceBindingService';
import { NotificationSubscriptionService } from '../utils/NotificationSubscriptionService';
import { withCancellableTimeout, withTimeout } from '../utils/withTimeout.js';
import { APP_RELEASE_TAG, APP_VERSION } from '../config/version';
import { parseWebhookConfig, type WebhookConfig, type SecretCompatibilityWindow } from './config';
import { getErrorMessage } from '../utils/errorUtils';
import type {
  SendFn,
  WebhookBody,
  WebhookDeliveryJob,
  WebhookDestination,
  WebhookEnqueuer,
  WebhookReadinessCheck,
  WebhookRoute,
} from './types';
import {
  asNonEmptyString,
  asRecord,
  isJsonContentType,
  mergeBindings,
  readRequestBytesWithLimit,
  resolveRoomIds,
  safeSecretCompare,
  truncateText,
  validateDestinationIds,
  validateReplayId,
  validateSource,
  verifyGitHubSignature,
  webhookRateLimitKeys,
  WebhookRateLimiter,
  WebhookReplayCache,
  WebhookRequestError,
} from './utils';
import { adaptJellyfin, adaptSeerr, buildWebhookMessage } from './adapters';
import { resolveSubscriptionDestination, resolveWebhookDestinations } from './rooms';

const log = logger.child({ module: 'WebhookServer' });
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const POST_PATHS = new Set(['/webhook', '/webhook/github', '/webhook/seerr', '/webhook/jellyfin']);
const GET_PATHS = new Set(['/health', '/live', '/ready', '/metrics']);
const MAX_READINESS_CHECKS = 32;

type ReplayContext = {
  key: string | null;
  eventId: string | null;
  reservation: 'reserved' | 'duplicate' | 'in_flight' | 'capacity' | null;
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export class WebhookServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly senders = new Map<string, SendFn>();
  private readonly readinessChecks = new Set<WebhookReadinessCheck>();
  private enqueuer: WebhookEnqueuer | null = null;
  private config: WebhookConfig | null = null;
  private rateLimiter: WebhookRateLimiter | null = null;
  private replayCache: WebhookReplayCache | null = null;
  private accepting = false;
  private now: () => number;

  /** Set by AppRuntime; absent in tests and in deployments without a token. */
  private adminHandler: ((req: Request, ip: string, server: unknown) => Promise<Response> | Response) | null = null;

  registerAdminHandler(handler: (req: Request, ip: string, server: unknown) => Promise<Response> | Response): void {
    this.adminHandler = handler;
  }

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  registerSender(platform: string, fn: SendFn): () => void {
    this.senders.set(platform, fn);
    return () => {
      if (this.senders.get(platform) === fn) this.senders.delete(platform);
    };
  }

  registerReadinessCheck(check: WebhookReadinessCheck): () => void {
    if (this.readinessChecks.size >= MAX_READINESS_CHECKS) {
      throw new Error(`At most ${MAX_READINESS_CHECKS} readiness checks may be registered`);
    }
    this.readinessChecks.add(check);
    return () => this.readinessChecks.delete(check);
  }

  registerEnqueuer(enqueuer: WebhookEnqueuer): () => void {
    this.enqueuer = enqueuer;
    return () => {
      if (this.enqueuer === enqueuer) this.enqueuer = null;
    };
  }

  private requireConfig(): WebhookConfig {
    if (!this.config) throw new Error('Webhook server is not configured');
    return this.config;
  }

  private async send(roomId: string, text: string, platform?: string): Promise<void> {
    const sendTimeoutMs = 15_000;
    const deliver = (name: string, fn: SendFn) =>
      withCancellableTimeout(
        signal => fn(roomId, text, signal),
        sendTimeoutMs,
        `webhook:${name}`,
      );

    if (platform && this.senders.has(platform)) {
      return deliver(platform, this.senders.get(platform)!);
    }

    // A destination with no explicit platform is resolved against the senders
    // that actually exist, and only when that is unambiguous.
    //
    // The previous fallback always preferred WhatsApp when any WhatsApp sender
    // existed and otherwise took the *first* registered sender, so a destination
    // whose platform could not be determined was delivered through whichever
    // provider happened to be registered first — a fabricated routing decision.
    // `AppRuntime.inferWebhookPlatform` had already been changed to refuse the
    // same guess, leaving the two halves of one subsystem disagreeing. With a
    // single registered sender the answer is unambiguous and is still served; with
    // several, the caller must name the platform, and the destination is reported
    // as failed rather than sent somewhere it was never addressed to.
    if (!platform && this.senders.size === 1) {
      const [onlyName, onlySend] = [...this.senders.entries()][0]!;
      return deliver(onlyName, onlySend);
    }

    const available = [...this.senders.keys()].join(', ') || 'none';
    throw new Error(
      `No sender for room_id ${roomId}`
      + (platform ? ` on platform "${platform}"` : ' without an explicit platform')
      + ` (registered senders: ${available})`,
    );
  }

  private isCompatibilityActive(window: SecretCompatibilityWindow, now: number): boolean {
    return window.enabled && window.expiresAt !== null && window.expiresAt > now;
  }

  private redactSecret(text: string, secret: string | null): string {
    return secret ? text.split(secret).join('[REDACTED]') : text;
  }

  private authenticateSharedSecret(
    req: Request,
    url: URL,
    body: WebhookBody,
    expected: string,
    config: WebhookConfig,
    now: number,
  ): boolean {
    const headerSecret = asNonEmptyString(req.headers.get('x-webhook-secret'));
    if (headerSecret && safeSecretCompare(headerSecret, expected)) return true;

    const authorization = req.headers.get('authorization');
    const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? null;
    if (bearer && safeSecretCompare(bearer, expected)) return true;

    if (this.isCompatibilityActive(config.bodySecretCompatibility, now)) {
      const bodySecret = asNonEmptyString(body.secret);
      if (bodySecret && safeSecretCompare(bodySecret, expected)) return true;
    }

    if (this.isCompatibilityActive(config.querySecretCompatibility, now)) {
      const querySecret = asNonEmptyString(url.searchParams.get('secret'));
      if (querySecret && safeSecretCompare(querySecret, expected)) return true;
    }

    return false;
  }

  private resolveSource(
    req: Request,
    body: WebhookBody,
    route: WebhookRoute,
    maxLength: number,
  ): string {
    const candidate = asNonEmptyString(req.headers.get('x-webhook-source'))
      || asNonEmptyString(body.source)
      || asNonEmptyString(body.service)
      || route;
    return validateSource(candidate, maxLength);
  }

  private resolveReplayContext(req: Request, route: WebhookRoute, now: number): ReplayContext {
    const rawId = route === 'github'
      ? asNonEmptyString(req.headers.get('x-github-delivery'))
      : asNonEmptyString(req.headers.get('x-webhook-id'))
        || asNonEmptyString(req.headers.get('x-event-id'));
    if (!rawId) return { key: null, eventId: null, reservation: null };

    const id = validateReplayId(rawId);
    const key = `${route}:${id}`;
    const reservation = this.replayCache
      ? this.replayCacheReservation(key, now)
      : 'capacity';
    return { key, eventId: id, reservation };
  }

  private replayCacheReservation(key: string, now: number): 'reserved' | 'duplicate' | 'in_flight' | 'capacity' {
    if (!this.replayCache) throw new Error('Replay cache is not initialized');
    return this.replayCache.reserve(key, now);
  }

  private completeReplay(context: ReplayContext): void {
    if (context.key && context.reservation === 'reserved') {
      if (!this.replayCache) throw new Error('Replay cache is not initialized');
      this.replayCache.complete(context.key, this.now());
    }
  }

  private releaseReplay(context: ReplayContext): void {
    if (context.key && context.reservation === 'reserved') {
      this.replayCache?.release(context.key);
    }
  }

  private duplicateResponse(): Response {
    if (this.enqueuer) {
      return jsonResponse({ ok: true, status: 'duplicate', duplicate: true }, 202);
    }
    return jsonResponse({ ok: true, duplicate: true, delivered: 0 });
  }

  private async dispatch(
    job: WebhookDeliveryJob,
    replay: ReplayContext,
  ): Promise<Response> {
    const config = this.requireConfig();
    if (this.enqueuer) {
      const enqueuer = this.enqueuer;
      let result: Awaited<ReturnType<WebhookEnqueuer>>;
      try {
        result = await withCancellableTimeout(
          signal => enqueuer(job, signal),
          config.enqueueTimeoutMs,
          'webhook:enqueue',
        );
      } catch {
        throw new WebhookRequestError(503, 'Webhook enqueue failed');
      }
      if (!result.accepted && !result.duplicate) {
        throw new WebhookRequestError(503, 'Webhook delivery was not accepted');
      }
      this.completeReplay(replay);
      return jsonResponse({
        ok: true,
        status: result.duplicate ? 'duplicate' : 'queued',
        duplicate: result.duplicate === true,
        deliveryId: result.deliveryId,
        ...(result.acceptedAt ? { acceptedAt: result.acceptedAt } : {}),
      }, 202);
    }

    const results = await Promise.allSettled(
      job.destinations.map(destination => this.send(
        destination.chatRoomId,
        job.text,
        destination.platform,
      )),
    );
    const failed = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [{ roomId: job.destinations[index]!.chatRoomId, error: 'Delivery failed' }]
        : [],
    );
    const delivered = job.destinations.length - failed.length;

    // Partial delivery keeps the replay reservation: a retry would re-send to
    // the destinations that already received the message (the duplicate the cache
    // exists to prevent), and 207 is a success for senders that only retry on
    // 5xx. Only a delivery where nothing was sent is retryable, so the key is
    // released and the answer is a 5xx in that one case.
    if (job.destinations.length > 0 && failed.length === job.destinations.length) {
      this.releaseReplay(replay);
      return jsonResponse({ ok: false, delivered: 0, failed }, 502);
    }
    if (failed.length > 0) {
      this.completeReplay(replay);
      return jsonResponse({ ok: false, delivered, failed }, 207);
    }

    this.completeReplay(replay);
    return jsonResponse({ ok: true, delivered });
  }

  private async addMediaTargets(
    userIds: Array<{ userId: string; platform: string }>,
    serviceType: 'seerr' | 'jellyfin',
    addTarget: (destination: WebhookDestination) => Promise<void>,
    eventType?: string,
  ): Promise<void> {
    const config = this.requireConfig();
    if (userIds.length > config.maxDestinations) {
      // The room-level cap logs when it drops targets; this binding-level cut
      // used to be silent, so a subscriber past the cap simply stopped hearing
      // from the bot with no signal anywhere.
      log.warn(
        { bindings: userIds.length, maxDestinations: config.maxDestinations, serviceType },
        '[Webhook] Binding fan-out cap reached; extra bindings were skipped',
      );
    }
    const bounded = userIds.slice(0, config.maxDestinations);
    const roomGroups = await Promise.all(
      bounded.map(binding =>
        // The event type must reach the subscription filter: without it
        // `matchesEvent` returns true and a digest-only or narrowed
        // subscription received every Seerr/Jellyfin event.
        NotificationSubscriptionService.getNotificationRooms(binding.userId, binding.platform, serviceType, eventType),
      ),
    );

    for (const rooms of roomGroups) {
      for (const room of rooms) {
        await addTarget({
          chatRoomId: room.chatRoomId,
          platform: room.platform,
          // Notification subscriptions already carry the canonical key; keep it
          // so a room is never re-registered under a second identity.
          ...(room.roomKey ? { roomKey: room.roomKey } : {}),
        });
      }
    }
  }

  private async handleMediaWebhook(
    route: 'seerr' | 'jellyfin',
    body: WebhookBody,
    url: URL,
    source: string,
    replay: ReplayContext,
  ): Promise<Response> {
    const config = this.requireConfig();
    const serviceType = route;
    const formatted = route === 'seerr' ? adaptSeerr(body) : adaptJellyfin(body);
    if (formatted === null) {
      this.completeReplay(replay);
      return jsonResponse({ ok: true, delivered: 0, note: 'Dropped: unactionable notification type' });
    }
    const serviceSecret = route === 'seerr' ? config.seerrSecret : config.jellyfinSecret;
    const text = this.redactSecret(truncateText(formatted, config.maxTextLength), serviceSecret);
    // The subscription's `notifyTypes` filter is keyed on the event name the
    // service sent, exactly as `adaptSeerr`/`adaptJellyfin` read it.
    const eventType = route === 'seerr'
      ? asNonEmptyString(body.notification_type) ?? undefined
      : asNonEmptyString(body.NotificationType) ?? undefined;
    const targets: WebhookDestination[] = [];
    const seen = new Set<string>();
    let droppedTargets = 0;
    /** First per-target resolution failure, re-raised only when nothing resolved. */
    let resolutionFailure: string | null = null;
    const addTarget = async (destination: WebhookDestination): Promise<void> => {
      if (seen.has(`${destination.chatRoomId}:${destination.platform ?? ''}`)) return;
      if (targets.length >= config.maxDestinations) {
        // The subscription fan-out is not caller-controlled, so exceeding the cap
        // is a deployment with many rooms, not a bad request. Throwing here made
        // the whole notification fail with nothing delivered; instead the extra
        // rooms are skipped and the count is logged.
        droppedTargets++;
        return;
      }
      // Resolution failures are permanent (an unknown platform, a room
      // re-registered on another platform, a legacy id). They must not fail the
      // whole notification: subscription rows come from the database, not from
      // the caller, so one stale row used to return 400 for *every* subscribed
      // room and the sender retried a request that could never succeed.
      let resolved: WebhookDestination;
      try {
        validateDestinationIds([destination.chatRoomId], config.maxRoomIdLength);
        resolved = await resolveSubscriptionDestination(destination.chatRoomId, destination.platform);
      } catch (error) {
        droppedTargets++;
        resolutionFailure ??= getErrorMessage(error);
        log.warn(
          { err: getErrorMessage(error), chatRoomId: destination.chatRoomId, platform: destination.platform ?? null },
          '[Webhook] Skipping an unresolvable notification target',
        );
        return;
      }
      // Two aliases of one room collapse onto the same canonical key.
      const key = `${resolved.roomKey || resolved.chatRoomId}:${resolved.platform ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push(resolved);
    };

    if (route === 'seerr') {
      const extra = asRecord(body.extra) ?? {};
      const username = asNonEmptyString(body.requestedBy_username)
        ?? asNonEmptyString(extra.requestedBy_username);
      const email = asNonEmptyString(body.requestedBy_email)
        ?? asNonEmptyString(extra.requestedBy_email);
      const [usernameBindings, emailBindings] = await Promise.all([
        username ? ServiceBindingService.findByExternalUsername('seerr', username) : Promise.resolve([]),
        email ? ServiceBindingService.findByExternalEmail('seerr', email) : Promise.resolve([]),
      ]);
      await this.addMediaTargets(mergeBindings(usernameBindings, emailBindings), serviceType, addTarget, eventType);
    } else {
      const userId = asNonEmptyString(body.UserId);
      const username = asNonEmptyString(body.NotificationUsername);
      const [userBindings, usernameBindings] = await Promise.all([
        userId ? ServiceBindingService.findByExternalUser('jellyfin', userId) : Promise.resolve([]),
        username ? ServiceBindingService.findByExternalUsername('jellyfin', username) : Promise.resolve([]),
      ]);
      await this.addMediaTargets(mergeBindings(userBindings, usernameBindings), serviceType, addTarget, eventType);
    }

    for (const room of await NotificationSubscriptionService.getAdminNotificationRooms(serviceType, eventType)) {
      await addTarget({ chatRoomId: room.chatRoomId, platform: room.platform });
    }

    if (droppedTargets > 0) {
      log.warn(
        { route, dropped: droppedTargets, maxDestinations: config.maxDestinations },
        '[Webhook] Destination cap reached; extra subscribed rooms were skipped',
      );
    }

    if (targets.length === 0) {
      if (resolutionFailure) {
        // Every candidate was dropped and at least one failed to resolve: report
        // the original reason instead of a misleading "No subscribers", which
        // the sender would read as a successful delivery to nobody. The replay
        // is released by the catch in handlePost, so a retry re-processes the
        // event instead of being answered `202 duplicate`.
        throw new WebhookRequestError(400, resolutionFailure);
      }
      this.completeReplay(replay);
      return jsonResponse({ ok: true, delivered: 0, note: 'No subscribers' });
    }

    return this.dispatch({
      eventId: replay.eventId,
      route,
      source,
      text,
      destinations: targets,
      receivedAt: new Date(this.now()).toISOString(),
    }, replay);
  }

  private async handleGenericWebhook(
    route: 'generic' | 'github',
    req: Request,
    url: URL,
    body: WebhookBody,
    source: string,
    replay: ReplayContext,
  ): Promise<Response> {
    const config = this.requireConfig();
    const roomIds = validateDestinationIds(resolveRoomIds(body, url), config.maxRoomIdLength);
    if (roomIds.length > config.maxDestinations) {
      throw new WebhookRequestError(400, 'Too many webhook destinations');
    }

    const textBody = route === 'generic' ? asNonEmptyString(body.text) : null;
    const formatted = route === 'generic' && textBody
      ? textBody
      // `buildWebhookMessage` sanitises the body itself; passing a sanitised copy
      // made every GitHub/generic request deep-copy and walk the payload twice.
      : buildWebhookMessage(Object.fromEntries(req.headers.entries()), body);
    const requestedPlatform = route === 'generic' ? asNonEmptyString(body.platform)?.toLowerCase() : null;
    // The allow-list used to be a hard-coded `!== 'discord' && !== 'whatsapp'`,
    // so a destination that explicitly named Telegram was rejected with a 400
    // even though the platform ships and works.
    if (requestedPlatform && !isSupportedPlatform(requestedPlatform)) {
      throw new WebhookRequestError(400, 'Invalid platform');
    }

    return this.dispatch({
      eventId: replay.eventId,
      route,
      source,
      text: this.redactSecret(truncateText(formatted, config.maxTextLength), config.sharedSecret),
      destinations: await resolveWebhookDestinations(roomIds, requestedPlatform),
      receivedAt: new Date(this.now()).toISOString(),
    }, replay);
  }

  private async handleReadiness(): Promise<Response> {
    const config = this.requireConfig();
    const payload = { status: 'ready', version: APP_VERSION, releaseTag: APP_RELEASE_TAG };
    if (this.readinessChecks.size === 0) {
      return jsonResponse(payload);
    }

    try {
      const checks = [...this.readinessChecks].map(check => Promise.resolve().then(check));
      const results = await withTimeout(
        Promise.all(checks),
        config.readinessTimeoutMs,
        'webhook:readiness',
      );
      const normalised = results.map(value => {
        if (typeof value === 'boolean') return { ready: value };
        if (value && typeof value === 'object') {
          const result = value as { ready?: boolean; details?: Record<string, unknown> };
          return { ...result, ready: result.ready !== false };
        }
        // A probe that returns nothing (or a non-object) did not report a
        // failure, so it does not make readiness false.
        return { ready: value !== false && value !== null && value !== undefined };
      });
      const ready = normalised.every(result => result.ready);
      const details: Record<string, unknown> = {};
      for (const result of normalised) {
        for (const [key, value] of Object.entries(result.details ?? {})) details[key] = value;
      }
      // `checks` is only added when a probe actually reported something. A bare
      // `false` from a probe must not change the response shape at all.
      return ready
        ? jsonResponse({ ...payload, ...(Object.keys(details).length > 0 ? { checks: details } : {}) })
        : jsonResponse(
          {
            status: 'not_ready',
            version: APP_VERSION,
            releaseTag: APP_RELEASE_TAG,
            ...(Object.keys(details).length > 0 ? { checks: details } : {}),
          },
          503,
        );
    } catch {
      return jsonResponse({ status: 'not_ready', version: APP_VERSION, releaseTag: APP_RELEASE_TAG }, 503);
    }
  }

  private handleMetrics(req: Request): Response {
    const token = this.requireConfig().metricsToken;
    if (!token) return new Response('Not Found', { status: 404 });
    const authorization = req.headers.get('authorization');
    const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? null;
    const headerToken = asNonEmptyString(req.headers.get('x-metrics-token'));
    // Either credential is accepted, like every other auth path. Preferring the
    // Bearer value meant a reverse proxy that injects its own Authorization
    // header made the documented X-Metrics-Token fallback unreachable.
    const credentials = [bearer, headerToken].filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (!credentials.some(value => safeSecretCompare(value, token))) {
      return jsonResponse({ error: 'Unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
    }
    return new Response(healthMetrics.getPrometheusMetrics(), {
      headers: { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' },
    });
  }

  private async handlePost(req: Request, url: URL, ip: string): Promise<Response> {
    const config = this.requireConfig();
    if (!config.enabled || !this.accepting) {
      throw new WebhookRequestError(503, 'Webhook intake is disabled');
    }
    if (!isJsonContentType(req.headers.get('content-type'))) {
      throw new WebhookRequestError(415, 'Content-Type must be application/json');
    }

    let bodyBytes: Uint8Array;
    let bodyRaw: string;
    let body: WebhookBody;
    try {
      bodyBytes = await readRequestBytesWithLimit(req, config.maxBodyBytes, config.bodyReadTimeoutMs);
      bodyRaw = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);
      const parsed = bodyRaw.trim() === '' ? null : JSON.parse(bodyRaw) as unknown;
      const record = asRecord(parsed);
      if (!record) throw new WebhookRequestError(400, 'JSON body must be an object');
      body = record;
    } catch (error) {
      if (error instanceof WebhookRequestError) throw error;
      throw new WebhookRequestError(400, 'Invalid JSON body');
    }

    const githubEvent = asNonEmptyString(req.headers.get('x-github-event'));
    const route: WebhookRoute = url.pathname === '/webhook/seerr'
      ? 'seerr'
      : url.pathname === '/webhook/jellyfin'
        ? 'jellyfin'
        : url.pathname === '/webhook/github' || githubEvent
          ? 'github'
          : 'generic';
    const source = this.resolveSource(req, body, route, config.maxSourceLength);

    if (route === 'github') {
      if (!config.sharedSecret) throw new WebhookRequestError(503, 'Webhook authentication is not configured');
      if (!githubEvent) throw new WebhookRequestError(400, 'Missing X-GitHub-Event header');
      if (githubEvent.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(githubEvent)) {
        throw new WebhookRequestError(400, 'Invalid X-GitHub-Event header');
      }
      if (!verifyGitHubSignature(bodyBytes, config.sharedSecret, req.headers.get('x-hub-signature-256'))) {
        return jsonResponse({ error: 'Invalid GitHub signature' }, 401);
      }
    } else if (route === 'generic') {
      if (!config.sharedSecret) throw new WebhookRequestError(503, 'Webhook authentication is not configured');
      if (!this.authenticateSharedSecret(req, url, body, config.sharedSecret, config, this.now())) {
        return jsonResponse({ error: 'Invalid or missing secret' }, 401);
      }
    } else {
      const serviceSecret = route === 'seerr' ? config.seerrSecret : config.jellyfinSecret;
      if (!serviceSecret) throw new WebhookRequestError(503, `${route} webhook authentication is not configured`);
      if (!this.authenticateSharedSecret(req, url, body, serviceSecret, config, this.now())) {
        return jsonResponse({ error: 'Invalid or missing secret' }, 401);
      }
    }

    if (!this.rateLimiter) {
      return jsonResponse({ error: 'Webhook server is not ready' }, 503);
    }
    const rate = this.rateLimiter.consume(webhookRateLimitKeys(route, source, ip), this.now());
    if (!rate.allowed) {
      return jsonResponse({ error: 'Rate limit exceeded' }, 429, {
        'Retry-After': String(rate.retryAfterSeconds),
      });
    }

    const replay = this.resolveReplayContext(req, route, this.now());
    if (replay.reservation === 'duplicate') return this.duplicateResponse();
    if (replay.reservation === 'in_flight') {
      // The same delivery id is being processed right now. A retryable answer is
      // the honest one: the in-flight attempt may still fail and release the key.
      return jsonResponse({ error: 'A request with this id is in progress' }, 503, { 'Retry-After': '1' });
    }
    if (replay.reservation === 'capacity') {
      return jsonResponse({ error: 'Replay cache is at capacity' }, 503, { 'Retry-After': '1' });
    }

    try {
      if (route === 'seerr' || route === 'jellyfin') {
        return await this.handleMediaWebhook(route, body, url, source, replay);
      }
      return await this.handleGenericWebhook(route, req, url, body, source, replay);
    } catch (error) {
      this.releaseReplay(replay);
      throw error;
    }
  }

  private async handleRequest(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
    const url = new URL(req.url);
    // The admin dashboard shares this port by design; delegating to one handler
    // keeps all of its routing and auth out of the webhook ingress path.
    if (this.adminHandler && (url.pathname === '/admin' || url.pathname.startsWith('/admin/'))) {
      const ip = server.requestIP(req)?.address ?? 'unknown';
      return this.adminHandler(req, ip, server);
    }
    if (POST_PATHS.has(url.pathname)) {
      if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method Not Allowed' }, 405, { Allow: 'POST' });
      }
      const ip = server.requestIP(req)?.address ?? 'unknown';
      return this.handlePost(req, url, ip);
    }

    if (GET_PATHS.has(url.pathname)) {
      if (req.method !== 'GET') {
        return jsonResponse({ error: 'Method Not Allowed' }, 405, { Allow: 'GET' });
      }
      if (url.pathname === '/health' || url.pathname === '/live') {
        return jsonResponse({ status: 'ok', version: APP_VERSION, releaseTag: APP_RELEASE_TAG });
      }
      if (url.pathname === '/ready') return this.handleReadiness();
      return this.handleMetrics(req);
    }

    return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  start(): void {
    if (this.server) return;
    this.config = parseWebhookConfig(process.env, this.now());
    this.rateLimiter = new WebhookRateLimiter(
      this.config.rateLimitMax,
      this.config.rateLimitWindowMs,
      this.config.rateLimitMaxSources,
    );
    this.replayCache = new WebhookReplayCache(this.config.replayTtlMs, this.config.replayMaxEntries);
    this.accepting = true;

    this.server = Bun.serve({
      hostname: this.config.host,
      port: this.config.port,
      error(error) {
        log.error({ err: error }, 'Unhandled webhook server error');
        return jsonResponse({ error: 'Internal server error' }, 500);
      },
      fetch: async (req, server) => {
        try {
          return await this.handleRequest(req, server);
        } catch (error) {
          const status = error instanceof WebhookRequestError ? error.status : 500;
          const publicMessage = error instanceof WebhookRequestError ? error.message : 'Internal server error';
          if (status >= 500) log.error({ err: error }, 'Webhook request failed');
          else log.warn({ pathname: new URL(req.url).pathname, status }, 'Webhook request rejected');
          return jsonResponse({ error: publicMessage }, status);
        }
      },
    });

    log.info({ host: this.config.host, port: this.config.port, enabled: this.config.enabled }, 'Webhook server started');
  }

  async stop(): Promise<void> {
    this.accepting = false;
    if (this.server) {
      try {
        await this.server.stop();
      } catch (error) {
        log.warn({ err: error }, 'Webhook server stop failed');
      }
      this.server = null;
      this.rateLimiter?.clear();
      this.replayCache?.clear();
      log.info('Webhook server stopped');
    }
  }
}
