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
 * Extract the bare number from a JID (e.g. "6281234567890@s.whatsapp.net" → "6281234567890").
 * Returns undefined if the JID has no recognisable number part.
 */
function bareNumber(jid: string | undefined): string | undefined {
  if (!jid) return undefined;
  const at = jid.indexOf('@');
  return at > 0 ? jid.slice(0, at) : undefined;
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
  sock: any,
  chatId: string,
  senderId: string,
  senderPn?: string,
): Promise<boolean> {
  if (!sock) return false;
  try {
    const metadata = await sock.groupMetadata(chatId);
    const participants: any[] = metadata.participants ?? [];

    // Build candidate IDs for matching
    const senderBare = bareNumber(senderId);
    const pnBare = bareNumber(senderPn);

    const participant = participants.find((p: any) => {
      if (p.id === senderId) return true;
      if (senderPn && p.id === senderPn) return true;
      // Bare-number fallback (strip @lid / @s.whatsapp.net and compare digits)
      const pBare = bareNumber(p.id);
      if (pBare && (pBare === senderBare || pBare === pnBare)) return true;
      return false;
    });

    const isAdmin = participant
      ? participant.admin === 'admin' || participant.admin === 'superadmin'
      : false;

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
  sock: any,
  chatId: string,
  senderId: string,
  isGroup: boolean,
  senderPn?: string,
): Promise<string[]> {
  logger.debug(
    { chatId, senderId, senderPn, isGroup },
    '[Permissions] resolveUserRoles — start',
  );

  const isPlatformAdmin = isGroup
    ? await isWhatsAppGroupAdmin(sock, chatId, senderId, senderPn)
    : false;

  const roles = await RoleService.resolveRoles(senderId, chatId, isPlatformAdmin, senderPn);

  logger.info(
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
  sock: any,
  chatId: string,
  senderId: string,
  isGroup: boolean,
  required: string,
  senderPn?: string,
): Promise<boolean> {
  if (required === 'user') return true;

  const roles = await resolveUserRoles(sock, chatId, senderId, isGroup, senderPn);
  const allowed = RoleService.hasPermission(roles, required);

  logger.debug(
    { senderId, senderPn, required, roles, allowed },
    '[Permissions] checkPermissions result',
  );

  return allowed;
}
