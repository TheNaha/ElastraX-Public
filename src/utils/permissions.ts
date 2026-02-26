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

/**
 * Checks whether a sender has the required permission level.
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

  if (required === 'owner') {
    const ownerJid = process.env.BOT_OWNER_JID;
    if (!ownerJid) return false;
    // Simple strict check. Ensure env var includes the domain if senderId does.
    return senderId === ownerJid;
  }

  if (required === 'admin') {
    if (!isGroup) {
      // In private chat, the user is always authorized as "admin" context doesn't apply
      // or we can treat them as admin of the private chat.
      return true;
    }

    if (!sock) {
      logger.warn('Socket not available for permission check');
      return false;
    }

    try {
      // sock.groupMetadata is a Baileys function
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
