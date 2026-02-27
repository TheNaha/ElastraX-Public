/**
 * @file src/tools/RoleTool.ts
 * @description Tool for managing user roles and per-role privileges.
 *
 * V7.11 set-based role model: user | premium | admin | owner
 *
 * Actions:
 *   grant    <user> <role> [scope]  — Assign a role to a user.
 *   revoke   <user> <role> [scope]  — Remove a specific role from a user.
 *   check    [user]                 — Show all roles & effective privileges of a user.
 *   list     [scope]                — List all explicitly-assigned roles for a scope.
 *   privs    <role>                 — Show current privileges for a role.
 *   setpriv  <role> <field> <value> — Override a privilege for a role (owner only).
 *   resetpriv <role>                — Reset a role to env/default privileges (owner only).
 *
 * Scope:
 *   - Omitted or "here"  → current chatId (group-local).
 *   - "global"           → applies everywhere.
 *
 * Permissions:
 *   - Viewing (check/list/privs): any user.
 *   - grant/revoke admin/premium: requires admin+.
 *   - grant/revoke owner: requires owner.
 *   - setpriv/resetpriv: owner only.
 *
 * Slash aliases: /role, /roles, /permission, /perm
 */

import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { RoleService, BUILTIN_ROLES } from '../utils/RoleService';
import { PrivilegeService, RolePrivileges } from '../utils/PrivilegeService';
import { resolveTargetUser } from '../utils/resolveTargetUser';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';

const PRIV_FIELDS: (keyof RolePrivileges)[] = [
  'maxMessagesPerWindow', 'rateLimitWindowSec', 'contextLimit', 'maxDownloadMb',
];

export class RoleTool extends BaseTool {
  readonly name = 'role';
  readonly description = 'Manage user roles and per-role privileges. Grant, revoke, check, or list roles. View/modify privilege quotas.';
  readonly aliases = ['roles', 'permission', 'perm'];
  readonly category = 'admin';
  readonly permissions = 'user'; // check/list available to everyone; grant/revoke enforced internally

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
              enum: ['grant', 'revoke', 'check', 'list', 'privs', 'setpriv', 'resetpriv'],
              description: 'The role management action to perform.',
            },
            user: {
              type: 'string',
              description: 'Target user: phone number, JID, "mentioned" (if @mentioned), or "quoted" (if replying to their message). Defaults to the sender for "check".',
            },
            role: {
              type: 'string',
              enum: ['user', 'premium', 'admin', 'owner'],
              description: 'The role to grant/revoke/inspect. Required for grant/revoke/privs/setpriv/resetpriv.',
            },
            scope: {
              type: 'string',
              description: 'Scope: "global" for everywhere, "here" or omit for current chat.',
            },
            field: {
              type: 'string',
              enum: ['maxMessagesPerWindow', 'rateLimitWindowSec', 'contextLimit', 'maxDownloadMb'],
              description: 'Privilege field to modify (for setpriv action).',
            },
            value: {
              type: 'string',
              description: 'New numeric value for the privilege field. Use -1 for unlimited, "null" to reset to default.',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    let { action, scope } = args;
    const { user, role, field, value } = args;
    const cmd = String(args.__command || '').toLowerCase();

    if (!action && cmd) action = 'check';

    // Normalise scope
    if (!scope || scope === 'here') scope = ctx.chatId;
    const scopeLabel = scope === 'global' ? 'global' : scope === ctx.chatId ? 'this chat' : scope;

    logger.info(
      { action, user, role, scope, senderId: ctx.senderId, senderPn: ctx.senderPn, chatId: ctx.chatId },
      '[RoleTool] execute — invoked',
    );

    // ── CHECK ──────────────────────────────────────────────────────────────
    if (action === 'check') {
      const resolved = resolveTargetUser(args, ctx, 'user');
      const targetId = resolved?.jid ?? ctx.senderId;
      const targetPn = targetId === ctx.senderId ? ctx.senderPn : undefined;

      // getUserRoles now internally uses IdentityService to find all JIDs
      const allDbRoles = await RoleService.getUserRoles(targetId);

      // Owner check — match against both LID and PN
      const ownerJid = process.env.BOT_OWNER_JID;
      const isEnvOwner = !!(ownerJid && (targetId === ownerJid || (targetPn && targetPn === ownerJid)));

      // Build effective role list for display
      const effectiveRoles = new Set<string>(['user']);
      if (isEnvOwner) effectiveRoles.add('owner');
      for (const r of allDbRoles) {
        if (r.scope === 'global' || r.scope === ctx.chatId) effectiveRoles.add(r.role);
      }

      const rolesStr = allDbRoles.length > 0
        ? allDbRoles.map(r => `• *${r.role}* (${r.scope === 'global' ? 'global' : r.scope})`).join('\n')
        : '_No explicit roles assigned_';

      const effectiveLabel = Array.from(effectiveRoles).join(', ');

      // Also show effective privileges
      const privs = await PrivilegeService.getEffective(Array.from(effectiveRoles));
      const privsStr = formatPrivileges(privs);

      logger.info(
        { targetId, targetPn, isEnvOwner, effectiveRoles: Array.from(effectiveRoles), dbRolesCount: allDbRoles.length },
        '[RoleTool] check — result',
      );

      return t(lang, 'role.check', {
        userId: targetId,
        effectiveRole: effectiveLabel,
        roles: rolesStr,
      }) + `\n\n*Effective privileges:*\n${privsStr}`;
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

    // ── PRIVS ──────────────────────────────────────────────────────────────
    if (action === 'privs') {
      const targetRole = role || 'user';
      const current = await PrivilegeService.getForRole(targetRole);
      const defaults = PrivilegeService.getDefaults(targetRole);
      let out = `📊 *Privileges for "${targetRole}":*\n`;
      for (const f of PRIV_FIELDS) {
        const cur = current[f];
        const def = defaults[f];
        const label = cur === -1 ? 'unlimited' : String(cur);
        const defLabel = def === -1 ? 'unlimited' : String(def);
        const overridden = cur !== def ? ' _(overridden)_' : '';
        out += `• *${f}:* ${label} (default: ${defLabel})${overridden}\n`;
      }
      return out;
    }

    // ── SETPRIV (owner only) ───────────────────────────────────────────────
    if (action === 'setpriv') {
      const callerRoles = await ctx.resolveRoles();
      if (!callerRoles.includes('owner')) {
        return t(lang, 'role.insufficient', { callerRole: callerRoles.join(','), targetRole: 'owner' });
      }
      if (!role) return '❌ Please specify a role. Example: /role setpriv premium contextLimit 50';
      if (!field || !PRIV_FIELDS.includes(field as keyof RolePrivileges)) {
        return `❌ Invalid field. Must be one of: ${PRIV_FIELDS.join(', ')}`;
      }
      const numValue = value === 'null' || value === undefined ? null : parseInt(String(value), 10);
      if (numValue !== null && Number.isNaN(numValue)) {
        return '❌ Value must be a number or "null" to reset to default.';
      }
      await PrivilegeService.setOverride(role, field as keyof RolePrivileges, numValue);
      const label = numValue === null ? 'default' : numValue === -1 ? 'unlimited' : String(numValue);
      return `✅ Set *${field}* for role *${role}* to *${label}*.`;
    }

    // ── RESETPRIV (owner only) ─────────────────────────────────────────────
    if (action === 'resetpriv') {
      const callerRoles = await ctx.resolveRoles();
      if (!callerRoles.includes('owner')) {
        return t(lang, 'role.insufficient', { callerRole: callerRoles.join(','), targetRole: 'owner' });
      }
      if (!role) return '❌ Please specify a role. Example: /role resetpriv premium';
      await PrivilegeService.resetToDefaults(role);
      return `✅ All privilege overrides for *${role}* have been reset to defaults.`;
    }

    // ── GRANT ──────────────────────────────────────────────────────────────
    if (action === 'grant') {
      if (!user) return t(lang, 'role.no_user');
      if (!role || !BUILTIN_ROLES.includes(role)) {
        return t(lang, 'role.invalid_role');
      }
      const resolved = resolveTargetUser(args, ctx, 'user');
      if (!resolved) return t(lang, 'role.no_user');
      const targetId = resolved.jid;

      const callerRoles = await ctx.resolveRoles();
      if (!canAssign(callerRoles, role)) {
        const callerLabel = callerRoles.filter(r => r !== 'user').join(',') || 'user';
        return t(lang, 'role.insufficient', { callerRole: callerLabel, targetRole: role });
      }

      await RoleService.setRole(targetId, role, scope, ctx.platform, ctx.senderId);
      logger.info({ targetId, role, scope, grantedBy: ctx.senderId }, '[RoleTool] Role granted');
      return t(lang, 'role.granted', { userId: targetId, role, scope: scopeLabel });
    }

    // ── REVOKE ─────────────────────────────────────────────────────────────
    if (action === 'revoke') {
      if (!user) return t(lang, 'role.no_user');
      const resolved = resolveTargetUser(args, ctx, 'user');
      if (!resolved) return t(lang, 'role.no_user');
      const targetId = resolved.jid;

      const revokeRole = role; // which specific role to revoke
      const callerRoles = await ctx.resolveRoles();

      if (revokeRole && !canAssign(callerRoles, revokeRole)) {
        const callerLabel = callerRoles.filter(r => r !== 'user').join(',') || 'user';
        return t(lang, 'role.insufficient', { callerRole: callerLabel, targetRole: revokeRole });
      }

      const removed = await RoleService.removeRole(targetId, scope, revokeRole);
      if (!removed) {
        return `❌ No matching role found for \`${targetId}\` in *${scopeLabel}*.`;
      }
      logger.info({ targetId, role: revokeRole, scope, revokedBy: ctx.senderId }, '[RoleTool] Role revoked');
      return t(lang, 'role.revoked', { userId: targetId, scope: scopeLabel });
    }

    return t(lang, 'role.usage');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Determine whether a caller with `callerRoles` can assign/revoke `targetRole`.
 * - owner can do anything.
 * - admin can grant/revoke user and premium.
 * - everyone else can only grant user.
 */
function canAssign(callerRoles: string[], targetRole: string): boolean {
  if (callerRoles.includes('owner')) return true;
  if (callerRoles.includes('admin') && (targetRole === 'user' || targetRole === 'premium')) return true;
  return false;
}

function formatPrivileges(p: RolePrivileges): string {
  const fmt = (v: number) => v === -1 ? 'unlimited' : String(v);
  return [
    `  Messages/window: *${fmt(p.maxMessagesPerWindow)}*`,
    `  Window (sec): *${fmt(p.rateLimitWindowSec)}*`,
    `  Context limit: *${fmt(p.contextLimit)}*`,
    `  Max download (MB): *${fmt(p.maxDownloadMb)}*`,
  ].join('\n');
}
