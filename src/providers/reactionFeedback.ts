import { logger } from '../utils/logger';
import { recordReactionFeedback } from '../utils/feedback';

export interface ReactionEntry {
  key?: {
    id?: string;
    remoteJid?: string;
    channelId?: string;
  };
  reaction?: string | { text?: string | null } | null;
}

export function collectReactionFeedback(
  platform: string,
  entries: ReadonlyArray<ReactionEntry>,
  isRemoval = false
): void {
  for (const entry of entries) {
    const key = entry.key;
    const messageId = key?.id ?? key?.channelId;
    const chatRoomId = key?.remoteJid ?? key?.channelId;
    if (!messageId || !chatRoomId) continue;
    try {
      const reaction = typeof entry.reaction === 'string' ? entry.reaction : (entry.reaction?.text ?? '');
      recordReactionFeedback({
        platform,
        chatRoomId,
        messageId,
        reaction,
        removed: isRemoval,
      });
    } catch (error) {
      logger.debug({ err: error, platform }, 'Failed to record reaction feedback');
    }
  }
}