export type WebhookBody = Record<string, unknown>;
export type SendFn = (chatId: string, text: string, signal?: AbortSignal) => Promise<void>;

export type WebhookRoute = 'generic' | 'github' | 'seerr' | 'jellyfin';

export type WebhookDestination = {
  /** Raw provider room id — the value handed to the provider. */
  chatRoomId: string;
  platform?: string;
  /** Canonical room key used for durable rows and dedupe. */
  roomKey?: string;
};

export type WebhookDeliveryJob = {
  eventId: string | null;
  route: WebhookRoute;
  source: string;
  text: string;
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

export type WebhookReadinessCheck = () => boolean | Promise<boolean>;
