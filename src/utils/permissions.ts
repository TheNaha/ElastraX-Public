/**
 * @file src/utils/permissions.ts
 * @description WhatsApp-specific permission & role resolution for slash commands.
 *
 * V7.11 set-based role model:
 *
 *  | Role      | Scope    | Source                                                |
 *  |-----------|----------|-------------------------------------------------------|
 *  | `user`    | global   | Implicit — every user.                                |
 *  | `premium` | global   | DB-granted.                                           |
 *  | `admin`   | per-room | DB-granted OR WA group admin/superadmin.              |
 *  | `owner`   | global   | BOT_OWNER_JID env OR DB-granted.                      |
 *
 * Exported helpers:
 *  - `resolveUserRoles(sock, chatId, senderId, isGroup)` — full role set.
 *  - `checkPermissions(sock, chatId, senderId, isGroup, required)` — boolean check.
 *  - `isWhatsAppGroupAdmin(sock, chatId, senderId)` — platform-native check.
 *
 * Configuration:
 *  - `BOT_OWNER_JID` — Full WhatsApp JID of the bot owner.
 */

import { logger } from './logger';
import { AuthService } from './AuthService';
import { jidUser as bareNumber } from './jid';

interface WhatsAppGroupParticipant {
  id?: string;
  admin?: string | null;
}

interface WhatsAppGroupMetadata {
  participants?: WhatsAppGroupParticipant[] | null;
}

interface WhatsAppGroupMetadataClient {
  groupMetadata(chatId: string): Promise<WhatsAppGroupMetadata>;
}

function hasGroupMetadataClient(sock: unknown): sock is WhatsAppGroupMetadataClient {
  if (typeof sock !== 'object' || sock === null) return false;
  const candidate = sock as { groupMetadata?: unknown };
  return typeof candidate.groupMetadata === 'function';
}

function isAdminParticipant(participant: WhatsAppGroupParticipant | undefined): boolean {
  return participant?.admin === 'admin' || participant?.admin === 'superadmin';
}

function matchesParticipant(
  participant: WhatsAppGroupParticipant,
  senderId: string,
  senderPn?: string,
): boolean {
  if (!participant.id) return false;
  if (participant.id === senderId) return true;
  if (senderPn && participant.id === senderPn) return true;

  const participantBare = bareNumber(participant.id);
  const senderBare = bareNumber(senderId);
  const pnBare = bareNumber(senderPn);

  return Boolean(participantBare && (participantBare === senderBare || participantBare === pnBare));
}

async function resolvePlatformAdmin(
  sock: unknown,
  chatId: string,
  senderId: string,
  isGroup: boolean,
  senderPn?: string,
  platform: PlatformName = 'whatsapp',
): Promise<boolean> {
  if (!isGroup) return false;
  return isNativeGroupAdmin(platform, { chatId, senderId, isGroup, senderPn, sock });
}

export type PlatformName = 'whatsapp' | 'discord' | (string & {});
export type NativeAdminResolver = (ctx: { chatId: string; senderId: string; isGroup: boolean; senderPn?: string; sock?: unknown; platform?: PlatformName }) => Promise<boolean>;

const nativeAdminResolvers = new Map<string, NativeAdminResolver>();
const groupMetadataCache = new Map<string, { data: WhatsAppGroupMetadata; expiresAt: number }>();

export function registerNativeAdminResolver(platform: PlatformName, resolver: NativeAdminResolver): () => void {
  const key = String(platform).trim().toLowerCase();
  nativeAdminResolvers.set(key, resolver);
  return () => {
    if (nativeAdminResolvers.get(key) === resolver) nativeAdminResolvers.delete(key);
  };
}

export const setNativeAdminResolver = registerNativeAdminResolver;

export function invalidateNativeAdminCache(chatId?: string, platform?: PlatformName): void {
  if (platform === undefined && (chatId === 'whatsapp' || chatId === 'discord')) {
    platform = chatId;
    chatId = undefined;
  }
  const platformKey = platform ? String(platform).trim().toLowerCase() : undefined;
  if (platformKey && chatId) {
    groupMetadataCache.delete(`${platformKey}:${chatId}`);
    return;
  }
  if (platformKey) {
    for (const key of [...groupMetadataCache.keys()]) {
      if (key.startsWith(`${platformKey}:`)) groupMetadataCache.delete(key);
    }
    return;
  }
  groupMetadataCache.clear();
}

export const invalidatePlatformAdminCache = invalidateNativeAdminCache;
export const invalidateWhatsAppAdminCache = (chatId?: string) => invalidateNativeAdminCache(chatId, 'whatsapp');
export const invalidateGroupAdminCache = invalidateNativeAdminCache;

export function clearNativeAdminResolvers(): void {
  nativeAdminResolvers.clear();
  invalidateNativeAdminCache();
}

export async function isDiscordGroupAdmin(
  ctx: { chatId: string; senderId: string; isGroup: boolean; member?: { permissions?: { has?: (permission: bigint | string) => boolean }; administrator?: boolean; roles?: { has?: (id: string) => boolean } }; permissionResolver?: (id: string) => Promise<boolean> | boolean },
  resolver?: NativeAdminResolver,
): Promise<boolean> {
  if (!ctx.isGroup) return false;
  if (resolver) {
    try { return await resolver({ ...ctx, platform: 'discord' }); } catch (error: unknown) { logger.warn({ err: error, chatId: ctx.chatId }, 'Discord admin resolver failed'); return false; }
  }
  if (ctx.member?.administrator === true) return true;
  if (ctx.member?.permissions?.has) {
    try {
      return ctx.member.permissions.has('Administrator') || ctx.member.permissions.has(0x2n);
    } catch {
      try { return ctx.member.permissions.has(BigInt(2)); } catch { return false; }
    }
  }
  if (ctx.permissionResolver) return ctx.permissionResolver(ctx.senderId);
  return false;
}

export async function isNativeGroupAdmin(
  platform: PlatformName,
  ctx: { chatId: string; senderId: string; isGroup: boolean; senderPn?: string; sock?: unknown },
): Promise<boolean> {
  if (!ctx.isGroup) return false;
  const resolver = nativeAdminResolvers.get(String(platform).trim().toLowerCase());
  if (resolver) {
    try { return await resolver({ ...ctx, platform }); } catch (error: unknown) { logger.warn({ err: error, platform, chatId: ctx.chatId }, 'Native admin resolver failed'); return false; }
  }
  if (platform === 'whatsapp') return isWhatsAppGroupAdmin(ctx.sock, ctx.chatId, ctx.senderId, ctx.senderPn);
  return false;
}

/**
 * Check whether a WhatsApp user is a native group admin/superadmin.
 *
 * Baileys V7 may report participants with LID JIDs while senderId is a
 * phone-number JID (or vice-versa).  We therefore try several matching
 * strategies:
 *  1. Exact match on `senderId`.
 *  2. Exact match on `senderPn` (phone-number JID).
 *  3. Bare-number comparison as final fallback.
 */
export async function isWhatsAppGroupAdmin(
  sock: unknown,
  chatId: string,
  senderId: string,
  senderPn?: string,
): Promise<boolean> {
  if (!hasGroupMetadataClient(sock)) return false;
  try {
    const cacheKey = `whatsapp:${chatId}`;
    const now = Date.now();
    const cached = groupMetadataCache.get(cacheKey);
    let metadata: WhatsAppGroupMetadata;

    if (cached && cached.expiresAt > now) {
      metadata = cached.data;
    } else {
      metadata = await sock.groupMetadata(chatId);
      // Cache for 5 minutes; sweep expired entries so the map cannot grow
      // unboundedly with every group ever seen.
      for (const [key, entry] of groupMetadataCache) {
        if (entry.expiresAt <= now) groupMetadataCache.delete(key);
      }
      groupMetadataCache.set(cacheKey, { data: metadata, expiresAt: now + 5 * 60 * 1000 });
    }

    const participants = metadata.participants ?? [];
    const participant = participants.find((entry) => matchesParticipant(entry, senderId, senderPn));
    const isAdmin = isAdminParticipant(participant);

    logger.debug(
      { chatId, senderId, senderPn, matched: !!participant, isAdmin },
      '[Permissions] isWhatsAppGroupAdmin result',
    );

    return isAdmin;
  } catch (error) {
    logger.error({ error, chatId, senderId }, '[Permissions] Failed to fetch group metadata for admin check');
    return false;
  }
}

/**
 * Resolve the full set of roles a WhatsApp user holds in a given context.
 *
 * @returns Array of role names (always includes `'user'`).
 */
export async function resolveUserRoles(
  sock: unknown,
  chatId: string,
  senderId: string,
  isGroup: boolean,
  senderPn?: string,
  platform: PlatformName = 'whatsapp',
): Promise<string[]> {
  logger.debug(
    { chatId, senderId, senderPn, isGroup },
    '[Permissions] resolveUserRoles — start',
  );

  const isPlatformAdmin = await resolvePlatformAdmin(sock, chatId, senderId, isGroup, senderPn, platform);

  const roles = await AuthService.resolveRoles(senderId, chatId, isPlatformAdmin, senderPn, platform);

  logger.debug(
    { senderId, senderPn, chatId, roles, isPlatformAdmin },
    '[Permissions] resolveUserRoles — resolved',
  );

  return roles;
}

/**
 * Checks whether a sender has the required role.
 *
 * @param sock     - Active Baileys socket.
 * @param chatId   - JID of the chat (group or DM).
 * @param senderId - JID of the message sender.
 * @param isGroup  - Whether the chat is a group.
 * @param required - Role name required by the tool.
 * @param senderPn - Phone-number JID (optional, for LID/PN dual matching).
 * @returns        `true` if the sender holds the required role.
 */
export async function checkPermissions(
  sock: unknown,
  chatId: string,
  senderId: string,
  isGroup: boolean,
  required: string,
  senderPn?: string,
  platform: PlatformName = 'whatsapp',
): Promise<boolean> {
  if (required === 'user') return true;

  const roles = await resolveUserRoles(sock, chatId, senderId, isGroup, senderPn, platform);
  const allowed = AuthService.hasPermission(roles, required);

  logger.debug(
    { senderId, senderPn, required, roles, allowed },
    '[Permissions] checkPermissions result',
  );

  return allowed;
}
