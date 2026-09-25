/**
 * @file src/webhooks/rooms.ts
 * @description Webhook destination resolution.
 *
 * Webhook payloads address rooms by their raw provider room id (WhatsApp JID or
 * Discord channel id) and may pin the platform.  Every destination is resolved
 * to the canonical, platform-scoped room key before dispatch:
 *
 *  - an explicit platform that is already registered for that remote id on
 *    another platform is rejected (400) instead of crossing platforms;
 *  - a remote id that exists on more than one platform without an explicit
 *    platform is rejected (400) instead of guessing;
 *  - providers always receive the raw remote room id.
 */

import {
  describeRoomResolutionFailure,
  resolveRemoteRoomDestinationAsync,
  type RoomResolutionFailure,
} from '../messaging/roomKeys';
import type { WebhookDestination } from './types';
import { WebhookRequestError } from './utils';

async function resolveOrThrow(remoteRoomId: string, platform?: string | null): Promise<WebhookDestination> {
  const resolution = await resolveRemoteRoomDestinationAsync(remoteRoomId, platform);
  if (!resolution.ok) {
    throw new WebhookRequestError(400, describeRoomResolutionFailure(resolution as RoomResolutionFailure));
  }
  return {
    chatRoomId: resolution.remoteRoomId,
    platform: resolution.platform ?? undefined,
    ...(resolution.roomKey ? { roomKey: resolution.roomKey } : {}),
  };
}

/** Resolve destinations supplied by a generic/GitHub webhook body or query. */
export async function resolveWebhookDestinations(
  remoteRoomIds: string[],
  requestedPlatform?: string | null,
): Promise<WebhookDestination[]> {
  const resolved: WebhookDestination[] = [];
  for (const remoteRoomId of remoteRoomIds) {
    resolved.push(await resolveOrThrow(remoteRoomId, requestedPlatform));
  }
  return resolved;
}

/** Resolve a notification destination recorded in `notification_subscriptions`. */
export async function resolveSubscriptionDestination(
  chatRoomId: string,
  platform: string | null | undefined,
): Promise<WebhookDestination> {
  return resolveOrThrow(chatRoomId, platform ?? null);
}
