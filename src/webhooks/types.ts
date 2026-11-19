export type WebhookBody = Record<string, unknown>;
export type SendFn = (chatId: string, text: string, signal?: AbortSignal) => Promise<void>;

export type WebhookRoute = 'generic' | 'github' | 'seerr' | 'jellyfin';

/** Locale codes understood by the translation table. */
export type WebhookLocale = 'en' | 'id';

export type WebhookDestination = {
  /** Raw provider room id — the value handed to the provider. */
  chatRoomId: string;
  platform?: string;
  /** Canonical room key used for durable rows and dedupe. */
  roomKey?: string;
  /** Room language, resolved once so each target reads the notice in its own language. */
  language?: WebhookLocale;
};

export type WebhookDeliveryJob = {
  eventId: string | null;
  route: WebhookRoute;
  source: string;
  text: string;
  /**
   * Per-locale renderings of `text`. `text` stays the English default: it is
   * what older queue rows and the idempotency key are built from.
   */
  textVariants?: Partial<Record<WebhookLocale, string>>;
  destinations: WebhookDestination[];
  receivedAt: string;
};

export type WebhookEnqueueResult = {
  accepted: boolean;
  duplicate?: boolean;
  deliveryId: string;
  acceptedAt?: string;
};

export type WebhookEnqueuer = (job: WebhookDeliveryJob, signal: AbortSignal) => Promise<WebhookEnqueueResult>;

/**
 * Readiness probe.
 *
 * Returning a detail object instead of a bare boolean lets `/ready` explain
 * *which* dependency is down. A bare boolean produced `503 {"status":"not_ready"}`
 * for a revoked Discord token or a missing intent, leaving an operator with no
 * signal at all about which subsystem had failed.
 */
export type WebhookReadinessResult = {
  ready: boolean;
  /** Short, non-secret explanations keyed by component. */
  details?: Record<string, unknown>;
};

export type WebhookReadinessCheck = () => boolean | WebhookReadinessResult | Promise<boolean | WebhookReadinessResult>;
