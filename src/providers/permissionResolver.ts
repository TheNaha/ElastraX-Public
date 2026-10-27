import { AuthService } from '../utils/AuthService';
import { IdentityService } from '../utils/IdentityService';
import { roleSatisfies } from '../core/roleAccess';
import type { MessageContext } from '../core/MessageContext';

export interface RoleResolverOptions {
  platform: string;
  userId: string;
  chatId?: string;
  isGroup?: boolean;
  senderPn?: string;
  senderHandle?: string;
  isPlatformAdmin?: boolean;
}

export async function resolveRoles(options: RoleResolverOptions): Promise<string[]> {
  const roles = new Set<string>(['user']);

  const ownerId = AuthService.resolveOwnerId(options.platform);
  const ownerMatchUserId = ownerId ? options.userId === ownerId : false;
  const ownerMatchPn = ownerId && options.senderPn ? options.senderPn === ownerId : false;

  if (ownerId && (ownerMatchUserId || ownerMatchPn)) {
    roles.add('owner');
  }

  if (options.isPlatformAdmin) {
    roles.add('admin');
  }

  try {
    let userIds: string[];
    let roleRows: Array<{ scope: string; role: string; scopeRoomKey?: string | null }>;

    try {
      const resolved = await IdentityService.getJidsAndRoles(options.userId, options.chatId, options.platform);
      userIds = resolved.jids;
      roleRows = resolved.roles;
      if (options.senderPn && !userIds.includes(options.senderPn)) {
        userIds.push(options.senderPn);
      }
    } catch {
      userIds = options.senderPn && options.senderPn !== options.userId ? [options.userId, options.senderPn] : [options.userId];
      roleRows = [];
    }

    for (const row of roleRows) {
      if (['user', 'premium', 'admin', 'owner'].includes(row.role) && (
        row.scope === 'global'
        || (options.chatId !== undefined && row.scope === options.chatId)
        || row.scope === options.senderHandle
      )) {
        roles.add(row.role);
      }
    }
  } catch {
    // Fallback handled above
  }

  return Array.from(roles);
}

export async function checkPermissions(roles: string[], required: string): Promise<boolean> {
  return roleSatisfies(roles, required);
}

export function createPermissionChecker(
  resolveRolesFn: () => Promise<string[]>
): MessageContext['checkPermissions'] {
  return async (required: string) => {
    const roles = await resolveRolesFn();
    return roleSatisfies(roles, required);
  };
}

export function createRoleResolver(
  resolveRolesFn: () => Promise<string[]>
): MessageContext['resolveRoles'] {
  return resolveRolesFn;
}