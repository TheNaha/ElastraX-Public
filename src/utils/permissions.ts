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
import { RoleService } from './RoleService';

/**
 * Check whether a WhatsApp user is a native group admin/superadmin.
 */
export async function isWhatsAppGroupAdmin(
  sock: any,
  chatId: string,
  senderId: string,
): Promise<boolean> {
  if (!sock) return false;
  try {
    const metadata = await sock.groupMetadata(chatId);
    const participant = metadata.participants.find((p: any) => p.id === senderId);
    if (!participant) return false;
    return participant.admin === 'admin' || participant.admin === 'superadmin';
  } catch (error) {
    logger.error({ error, chatId }, 'Failed to fetch group metadata for permission check');
    return false;
  }
}

/**
 * Resolve the full set of roles a WhatsApp user holds in a given context.
 *
 * @returns Array of role names (always includes `'user'`).
 */
export async function resolveUserRoles(
  sock: any,
  chatId: string,
  senderId: string,
  isGroup: boolean,
): Promise<string[]> {
  const isPlatformAdmin = isGroup
    ? await isWhatsAppGroupAdmin(sock, chatId, senderId)
    : false;

  return RoleService.resolveRoles(senderId, chatId, isPlatformAdmin);
}

/**
 * Checks whether a sender has the required role.
 *
 * @param sock     - Active Baileys socket.
 * @param chatId   - JID of the chat (group or DM).
 * @param senderId - JID of the message sender.
 * @param isGroup  - Whether the chat is a group.
 * @param required - Role name required by the tool.
 * @returns        `true` if the sender holds the required role.
 */
export async function checkPermissions(
  sock: any,
  chatId: string,
  senderId: string,
  isGroup: boolean,
  required: string,
): Promise<boolean> {
  if (required === 'user') return true;

  const roles = await resolveUserRoles(sock, chatId, senderId, isGroup);
  return RoleService.hasPermission(roles, required);
}
