/**
 * @file src/utils/permissions.ts
 * @description WhatsApp-specific permission checking for slash commands.
 *
 * ElastraX supports three permission levels (defined on each `BaseTool`):
 *
 *  | Level   | Who can use it                                                          |
 *  |---------|-------------------------------------------------------------------------|
 *  | `user`  | Any chat participant.                                                   |
 *  | `admin` | Group admins/super-admins in group chats; any user in private chats.   |
 *  | `owner` | Only the JID stored in the `BOT_OWNER_JID` environment variable.       |
 *
 * The `checkPermissions` function is called by the WhatsApp provider's `MessageContext`.
 * The Discord provider implements the equivalent logic inline in `discord.ts` using the
 * `PermissionsBitField` API.
 *
 * Configuration:
 *  - `BOT_OWNER_JID` — Full WhatsApp JID of the bot owner (e.g., `628xxxxxxxxx@s.whatsapp.net`).
 *    If not set, `owner`-level commands are inaccessible to everyone.
 */

import { logger } from './logger';
import { RoleService } from './RoleService';

/**
 * Checks whether a sender has the required permission level.
 *
 * Lookup order:
 *  1. `user` level → always true.
 *  2. `owner` level → BOT_OWNER_JID env check, then DB role check.
 *  3. `admin` level → DB role check, then platform-native (WhatsApp group admin / Discord perms).
 *
 * @param sock     - Active Baileys socket (needed to fetch group metadata for admin checks).
 * @param chatId   - JID of the chat (group or DM).
 * @param senderId - JID of the message sender.
 * @param isGroup  - Whether the chat is a group.
 * @param required - Minimum permission level required by the tool.
 * @returns        `true` if the sender meets the required level, `false` otherwise.
 */
export async function checkPermissions(
  sock: any,
  chatId: string,
  senderId: string,
  isGroup: boolean,
  required: 'user' | 'admin' | 'owner'
): Promise<boolean> {
  if (required === 'user') return true;

  // ── Owner check ─────────────────────────────────────────────────────────
  if (required === 'owner') {
    const ownerJid = process.env.BOT_OWNER_JID;
    if (ownerJid && senderId === ownerJid) return true;

    // Check DB-assigned owner role
    const dbRole = await RoleService.getEffectiveRole(senderId, chatId);
    if (dbRole && RoleService.meetsRequirement(dbRole, 'owner')) return true;

    return false;
  }

  // ── Admin check ─────────────────────────────────────────────────────────
  if (required === 'admin') {
    // Env owner is always an admin too
    const ownerJid = process.env.BOT_OWNER_JID;
    if (ownerJid && senderId === ownerJid) return true;

    // DB-assigned role (admin or owner covers admin requirement)
    const dbRole = await RoleService.getEffectiveRole(senderId, chatId);
    if (dbRole && RoleService.meetsRequirement(dbRole, 'admin')) return true;

    // Private chat: treat as admin (backward compat)
    if (!isGroup) return true;

    // Platform-native check (WhatsApp group admin)
    if (!sock) {
      logger.warn('Socket not available for permission check');
      return false;
    }

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

  return false;
}
