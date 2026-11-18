/**
 * @file src/utils/toolAccess.ts
 * @description Shared guards for tool access, so the same decision is made in
 * one place instead of being re-written at every call site.
 */

import type { MessageContext } from '../core/MessageContext';
import { ServiceBindingService } from './ServiceBindingService';

/** True when a stored binding belongs to a different platform than the message. */
export function bindingPlatformMismatch(
  binding: { platform?: string } | null | undefined,
  platform: string,
): boolean {
  return !!binding?.platform && binding.platform !== platform;
}

/**
 * Whether the sender has a linked media-service account.
 *
 * A failure to read the binding table is treated as "no binding" so a database
 * problem hides the media tools rather than exposing them.
 */
export async function resolveSenderHasBinding(
  senderId: string | undefined,
  platform: string | undefined,
): Promise<boolean> {
  if (!senderId || !platform) return false;
  try {
    const [binding, seerr] = await Promise.all([
      ServiceBindingService.getBinding(senderId, platform, 'jellyfin'),
      ServiceBindingService.getBinding(senderId, platform, 'seerr'),
    ]);
    return Boolean(binding || seerr);
  } catch {
    return false;
  }
}

/** True when `ctx` is allowed to perform `required`. Falls back to allow when
 * the context exposes no permission check function. */
export async function hasPermission(ctx: MessageContext, required: string): Promise<boolean> {
  return typeof ctx.checkPermissions !== 'function' || (await ctx.checkPermissions(required));
}
