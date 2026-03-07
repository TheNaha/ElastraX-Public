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

/**
 * Extract the bare number from a JID (e.g. "6281234567890@s.whatsapp.net" → "6281234567890").
 * Returns undefined if the JID has no recognisable number part.
 */
function bareNumber(jid: string | undefined): string | undefined {
  if (!jid) return undefined;
  const at = jid.indexOf('@');
  return at > 0 ? jid.slice(0, at) : undefined;
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
): Promise<boolean> {
  if (!isGroup) return false;
  return isWhatsAppGroupAdmin(sock, chatId, senderId, senderPn);
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
    const metadata = await sock.groupMetadata(chatId);
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
): Promise<string[]> {
  logger.debug(
    { chatId, senderId, senderPn, isGroup },
    '[Permissions] resolveUserRoles — start',
  );

  const isPlatformAdmin = await resolvePlatformAdmin(sock, chatId, senderId, isGroup, senderPn);

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
  sock: unknown,
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
