/**
 * @file src/tools/RoleTool.ts
 * @description Tool for managing user roles (user / admin / owner).
 *
 * Actions:
 *   grant  <user> <role> [scope]  — Assign a role to a user.
 *   revoke <user> [scope]         — Remove a user's assigned role.
 *   check  [user]                 — Show the effective role of a user (self if omitted).
 *   list   [scope]                — List all explicitly-assigned roles for a scope.
 *
 * Scope:
 *   - Omitted or "here"  → current chatId (group-local).
 *   - "global"           → applies everywhere.
 *
 * Permissions:
 *   - Viewing (check/list): any user.
 *   - Granting admin: requires admin+.
 *   - Granting/revoking owner: requires owner.
 *   - You cannot grant a role equal to or higher than your own unless you are the owner.
 *
 * Slash aliases: /role, /roles, /permission, /perm
 * Conversational: "make @User an admin", "check my role"
 */

import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { RoleService, RoleName } from '../utils/RoleService';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';

const VALID_ROLES: RoleName[] = ['user', 'admin', 'owner'];

export class RoleTool extends BaseTool {
  readonly name = 'role';
  readonly description = 'Manage user roles and permissions. Grant, revoke, check, or list roles for users in this chat or globally.';
  readonly aliases = ['roles', 'permission', 'perm'];
  readonly category = 'admin';
  readonly permissions = 'user'; // check/list is available to everyone; grant/revoke enforced internally

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['grant', 'revoke', 'check', 'list'],
              description: 'The role management action to perform.',
            },
            user: {
              type: 'string',
              description: 'Phone number, JID, or user ID of the target user. For "check" defaults to the sender.',
            },
            role: {
              type: 'string',
              enum: ['user', 'admin', 'owner'],
              description: 'The role to grant. Required for "grant" action.',
            },
            scope: {
              type: 'string',
              description: 'Scope: "global" for everywhere, "here" or omit for current chat.',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    let { action, user, role, scope } = args;
    const cmd = String(args.__command || '').toLowerCase();

    // Infer action from alias
    if (!action && cmd) {
      action = 'check'; // default for /role with no args
    }

    // Normalise scope
    if (!scope || scope === 'here') {
      scope = ctx.chatId;
    }
    const scopeLabel = scope === 'global' ? 'global' : scope === ctx.chatId ? 'this chat' : scope;

    // ── CHECK ──────────────────────────────────────────────────────────────
    if (action === 'check') {
      const targetId = user ? normaliseUserId(user) : ctx.senderId;
      const dbRole = await RoleService.getEffectiveRole(targetId, ctx.chatId);
      const isEnvOwner = targetId === process.env.BOT_OWNER_JID;
      const effectiveRole = isEnvOwner ? 'owner' : (dbRole || 'user');

      const allRoles = await RoleService.getUserRoles(targetId);
      const rolesStr = allRoles.length > 0
        ? allRoles.map(r => `• *${r.role}* (${r.scope === 'global' ? 'global' : r.scope})`).join('\n')
        : '_No explicit roles assigned_';

      return t(lang, 'role.check', {
        userId: targetId,
        effectiveRole,
        roles: rolesStr,
      });
    }

    // ── LIST ───────────────────────────────────────────────────────────────
    if (action === 'list') {
      const roles = await RoleService.listRoles(scope);
      if (roles.length === 0) {
        return t(lang, 'role.list_empty', { scope: scopeLabel });
      }
      const items = roles
        .map((r, i) => `${i + 1}. *${r.role}* — ${r.userId} (by ${r.grantedBy})`)
        .join('\n');
      return t(lang, 'role.list', { scope: scopeLabel, items });
    }

    // ── GRANT ──────────────────────────────────────────────────────────────
    if (action === 'grant') {
      if (!user) return t(lang, 'role.no_user');
      if (!role || !VALID_ROLES.includes(role as RoleName)) {
        return t(lang, 'role.invalid_role');
      }
      const targetRole = role as RoleName;
      const targetId = normaliseUserId(user);

      // Authorisation: determine the caller's effective role
      const callerRole = await getCallerRole(ctx);
      if (!canAssign(callerRole, targetRole)) {
        return t(lang, 'role.insufficient', { callerRole, targetRole: targetRole });
      }

      await RoleService.setRole(targetId, targetRole, scope, ctx.platform, ctx.senderId);
      logger.info({ targetId, role: targetRole, scope, grantedBy: ctx.senderId }, '[RoleTool] Role granted');
      return t(lang, 'role.granted', { userId: targetId, role: targetRole, scope: scopeLabel });
    }

    // ── REVOKE ─────────────────────────────────────────────────────────────
    if (action === 'revoke') {
      if (!user) return t(lang, 'role.no_user');
      const targetId = normaliseUserId(user);

      // Check what the target currently has
      const targetCurrent = await RoleService.getEffectiveRole(targetId, scope === 'global' ? undefined : scope);
      const callerRole = await getCallerRole(ctx);

      // Can only revoke if you outrank the target's current role
      if (targetCurrent && !canAssign(callerRole, targetCurrent)) {
        return t(lang, 'role.insufficient', { callerRole, targetRole: targetCurrent });
      }

      await RoleService.removeRole(targetId, scope);
      logger.info({ targetId, scope, revokedBy: ctx.senderId }, '[RoleTool] Role revoked');
      return t(lang, 'role.revoked', { userId: targetId, scope: scopeLabel });
    }

    return t(lang, 'role.usage');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function normaliseUserId(input: string): string {
  // Strip mentions, @, leading 0→62, etc.
  let cleaned = input.replace(/[<>@!]/g, '').trim();
  // If pure digits, assume WhatsApp phone
  if (/^\d+$/.test(cleaned)) {
    if (cleaned.startsWith('0')) cleaned = '62' + cleaned.slice(1);
    if (!cleaned.includes('@')) cleaned += '@s.whatsapp.net';
  }
  return cleaned;
}

async function getCallerRole(ctx: MessageContext): Promise<RoleName> {
  // 1. Env owner always wins
  if (ctx.senderId === process.env.BOT_OWNER_JID) return 'owner';
  // 2. DB role
  const dbRole = await RoleService.getEffectiveRole(ctx.senderId, ctx.chatId);
  if (dbRole) return dbRole;
  // 3. Platform-native admin
  const isNativeAdmin = await ctx.checkPermissions('admin');
  if (isNativeAdmin) return 'admin';
  return 'user';
}

function canAssign(callerRole: RoleName, targetRole: RoleName): boolean {
  // owner can do anything
  if (callerRole === 'owner') return true;
  // admin can only grant/revoke user roles
  if (callerRole === 'admin' && targetRole === 'user') return true;
  // Otherwise, not allowed
  return false;
}
