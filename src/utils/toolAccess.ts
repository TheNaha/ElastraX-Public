/**
 * @file src/utils/toolAccess.ts
 * @description Shared guards for tool access, so the same decision is made in
 * one place instead of being re-written at every call site.
 */

import type { MessageContext } from '../core/MessageContext';

/** True when a stored binding belongs to a different platform than the message. */
export function bindingPlatformMismatch(
  binding: { platform?: string } | null | undefined,
  platform: string,
): boolean {
  return !!binding?.platform && binding.platform !== platform;
}

/** True when `ctx` is allowed to perform `required`. Falls back to allow when
 * the context exposes no permission check function. */
export async function hasPermission(ctx: MessageContext, required: string): Promise<boolean> {
  return typeof ctx.checkPermissions !== 'function' || (await ctx.checkPermissions(required));
}
