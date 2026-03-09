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

import { BaseTool, ToolDefinition, ToolResult } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { RoleService, BUILTIN_ROLES } from '../utils/RoleService';
import { PrivilegeService, PRIVILEGE_FIELDS, isPrivilegeField } from '../utils/PrivilegeService';
import type { RolePrivileges } from '../utils/PrivilegeService';
import { IdentityService } from '../utils/IdentityService';
import { resolveTargetUser } from '../utils/resolveTargetUser';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'RoleTool' });

type RoleToolArgs = {
  action?: string;
  user?: string;
  role?: string;
  scope?: string;
  field?: string;
  value?: string;
  __command?: string;
};

type RoleSummary = {
  explicitRoles: string;
  effectiveRoles: string[];
};

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

  async execute(args: RoleToolArgs, ctx: MessageContext): Promise<ToolResult> {
    const lang = ctx.language ?? 'en';
    let { action, scope } = args;
    const { user, role, field, value } = args;
    const cmd = String(args.__command || '').toLowerCase();

    log.debug({ action, role, scope, senderId: ctx.senderId, chatId: ctx.chatId }, 'Role action requested');

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

      log.debug({ targetId, chatId: ctx.chatId }, 'Checking roles for user');

      const summary = targetId === ctx.senderId
        ? await buildSenderRoleSummary(ctx)
        : await buildTargetRoleSummary(targetId, ctx.chatId);
      const accessProfile = await RoleService.getAccessProfile(summary.effectiveRoles);
      const privsStr = formatPrivileges(accessProfile.privileges);

      logger.info(
        { targetId, effectiveRoles: summary.effectiveRoles },
        '[RoleTool] check — result',
      );

      // Resolve display name for mention
      const { tag, mentionJid } = await resolveUserTag(targetId);
      const mentions = mentionJid ? [mentionJid] : [];

      const text = t(lang, 'role.check', {
        userTag: tag,
        effectiveRole: summary.effectiveRoles.join(', '),
        roles: summary.explicitRoles,
      }) + `\n\n*Effective privileges:*\n${privsStr}`;

      return mentions.length > 0 ? { text, mentions } : text;
    }

    // ── LIST ───────────────────────────────────────────────────────────────
    if (action === 'list') {
      const roles = await RoleService.listRoles(scope);
      if (roles.length === 0) {
        return t(lang, 'role.list_empty', { scope: scopeLabel });
      }

      const mentions: string[] = [];
      const itemLines: string[] = [];

      for (let i = 0; i < roles.length; i++) {
        const r = roles[i];
        const userRes = await resolveUserTag(r.userId);
        const byRes = await resolveUserTag(r.grantedBy);
        if (userRes.mentionJid) mentions.push(userRes.mentionJid);
        if (byRes.mentionJid) mentions.push(byRes.mentionJid);
        itemLines.push(`${i + 1}. *${r.role}* — ${userRes.tag} (by ${byRes.tag})`);
      }

      const text = t(lang, 'role.list', { scope: scopeLabel, items: itemLines.join('\n') });
      return mentions.length > 0 ? { text, mentions } : text;
    }

    // ── PRIVS ──────────────────────────────────────────────────────────────
    if (action === 'privs') {
      const targetRole = role || 'user';
      const current = await PrivilegeService.getForRole(targetRole);
      const defaults = PrivilegeService.getDefaults(targetRole);
      let out = `📊 *Privileges for "${targetRole}":*\n`;
      for (const f of PRIVILEGE_FIELDS) {
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
      const callerAccess = await RoleService.getAccessProfile(await ctx.resolveRoles());
      if (!callerAccess.roles.includes('owner')) {
        return t(lang, 'role.insufficient', { callerRole: callerAccess.roles.join(','), targetRole: 'owner' });
      }
      if (!role) return '❌ Please specify a role. Example: /role setpriv premium contextLimit 50';
      if (!isPrivilegeField(field)) {
        return `❌ Invalid field. Must be one of: ${PRIVILEGE_FIELDS.join(', ')}`;
      }
      const numValue = value === 'null' || value === undefined ? null : parseInt(String(value), 10);
      if (numValue !== null && Number.isNaN(numValue)) {
        return '❌ Value must be a number or "null" to reset to default.';
      }
      await PrivilegeService.setOverride(role, field, numValue);
      const label = numValue === null ? 'default' : numValue === -1 ? 'unlimited' : String(numValue);
      log.info({ role, field, value: numValue, setBy: ctx.senderId }, 'Privilege override set');
      return `✅ Set *${field}* for role *${role}* to *${label}*.`;
    }

    // ── RESETPRIV (owner only) ─────────────────────────────────────────────
    if (action === 'resetpriv') {
      const callerAccess = await RoleService.getAccessProfile(await ctx.resolveRoles());
      if (!callerAccess.roles.includes('owner')) {
        return t(lang, 'role.insufficient', { callerRole: callerAccess.roles.join(','), targetRole: 'owner' });
      }
      if (!role) return '❌ Please specify a role. Example: /role resetpriv premium';
      await PrivilegeService.resetToDefaults(role);
      log.info({ role, resetBy: ctx.senderId }, 'Privilege overrides reset to defaults');
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
      const resolvedTarget = resolved.jid;

      const identity = await IdentityService.getIdentity(resolvedTarget);
      const targetId = identity?.lid ? identity.lid : resolvedTarget;

      const callerRoles = await ctx.resolveRoles();
      if (!canAssign(callerRoles, role)) {
        const callerLabel = callerRoles.filter(r => r !== 'user').join(',') || 'user';
        return t(lang, 'role.insufficient', { callerRole: callerLabel, targetRole: role });
      }

      await RoleService.setRole(targetId, role, scope, ctx.platform, ctx.senderId);
      logger.info({ targetId, role, scope, grantedBy: ctx.senderId }, '[RoleTool] Role granted');

      const { tag, mentionJid } = await resolveUserTag(targetId);
      const text = t(lang, 'role.granted', { userTag: tag, role, scope: scopeLabel });
      return mentionJid ? { text, mentions: [mentionJid] } : text;
    }

    // ── REVOKE ─────────────────────────────────────────────────────────────
    if (action === 'revoke') {
      if (!user) return t(lang, 'role.no_user');
      const resolved = resolveTargetUser(args, ctx, 'user');
      if (!resolved) return t(lang, 'role.no_user');
      const resolvedTarget = resolved.jid;

      const identity = await IdentityService.getIdentity(resolvedTarget);
      const targetId = identity?.lid ? identity.lid : resolvedTarget;

      const revokeRole = role; // which specific role to revoke
      const callerRoles = await ctx.resolveRoles();

      if (revokeRole && !canAssign(callerRoles, revokeRole)) {
        const callerLabel = callerRoles.filter(r => r !== 'user').join(',') || 'user';
        return t(lang, 'role.insufficient', { callerRole: callerLabel, targetRole: revokeRole });
      }

      const removed = await RoleService.removeRole(targetId, scope, revokeRole);
      if (!removed) {
        const { tag } = await resolveUserTag(targetId);
        return `❌ No matching role found for ${tag} in *${scopeLabel}*.`;
      }
      logger.info({ targetId, role: revokeRole, scope, revokedBy: ctx.senderId }, '[RoleTool] Role revoked');

      const { tag, mentionJid } = await resolveUserTag(targetId);
      const text = t(lang, 'role.revoked', { userTag: tag, scope: scopeLabel });
      return mentionJid ? { text, mentions: [mentionJid] } : text;
    }

    return t(lang, 'role.usage');
  }
}

// ── Role Summary ───────────────────────────────────────────────────────────────

function formatExplicitRoles(
  roles: Array<{ role: string; scope: string }>,
): string {
  return roles.length > 0
    ? roles.map((entry) => `• *${entry.role}* (${entry.scope === 'global' ? 'global' : entry.scope})`).join('\n')
    : '_No explicit roles assigned_';
}

async function buildTargetRoleSummary(targetId: string, chatId: string, targetPn?: string): Promise<RoleSummary> {
  const allDbRoles = await RoleService.getUserRoles(targetId);
  const effectiveRoles = new Set<string>(['user']);
  const ownerJid = process.env.BOT_OWNER_JID;
  const isEnvOwner = !!(ownerJid && (targetId === ownerJid || (targetPn && targetPn === ownerJid)));

  if (isEnvOwner) effectiveRoles.add('owner');
  for (const row of allDbRoles) {
    if (row.scope === 'global' || row.scope === chatId) effectiveRoles.add(row.role);
  }

  return {
    explicitRoles: formatExplicitRoles(allDbRoles),
    effectiveRoles: Array.from(effectiveRoles),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function buildSenderRoleSummary(ctx: MessageContext): Promise<RoleSummary> {
  const allDbRoles = await RoleService.getUserRoles(ctx.senderId);
  return {
    explicitRoles: formatExplicitRoles(allDbRoles),
    effectiveRoles: await ctx.resolveRoles(),
  };
}

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

/** Strip `@domain` and `:device` suffixes for display. */
function bareNumber(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/**
 * Resolve a JID into a display tag and (optionally) a mentionable PN JID.
 *
 * Returns:
 *  - `tag`        — The display text to embed in the message.
 *                   `@<phone>` when mentionable (PN known), otherwise the
 *                   display name or bare digits (no `@` prefix).
 *  - `mentionJid` — A `@s.whatsapp.net` JID for the Baileys `mentions` array,
 *                   or `null` when the user can't be @-mentioned.
 *
 * WhatsApp only renders clickable mentions for `@s.whatsapp.net` JIDs.
 * LID-only users are shown as plain text so WhatsApp doesn't swallow the tag.
 */
async function resolveUserTag(jid: string): Promise<{ tag: string; mentionJid: string | null }> {
  try {
    const identity = await IdentityService.getIdentity(jid);
    if (identity) {
      // Prefer PN — this is the only path that produces a real mention
      if (identity.pn) {
        return { tag: `@${bareNumber(identity.pn)}`, mentionJid: identity.pn };
      }
      // No PN known — show displayName or LID digits (no mention)
      if (identity.displayName) {
        return { tag: identity.displayName, mentionJid: null };
      }
    }
  } catch {
    // IdentityService unavailable (e.g. in tests) — fall through
  }

  // If the JID itself is a PN, we can still @-mention
  if (jid.endsWith('@s.whatsapp.net')) {
    return { tag: `@${bareNumber(jid)}`, mentionJid: jid };
  }

  // LID or unknown — plain text, no mention
  return { tag: bareNumber(jid), mentionJid: null };
}
