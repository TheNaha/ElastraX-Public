import { logger } from './logger';

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
