import type { MessageContext } from '../core/MessageContext';
import { jidBareId as bareId } from './jid';

export type ResolvedUserSource = 'mention' | 'quoted' | 'phone' | 'jid' | 'lid' | 'discord';

export interface ResolvedUser {
  jid: string;
  display: string;
  source: ResolvedUserSource;
}

function isPureDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

function phoneToJid(raw: string): string | null {
  if (!isPureDigits(raw)) return null;
  const normalized = raw.startsWith('0') ? `62${raw.slice(1)}` : raw;
  if (normalized.length < 8 || normalized.length > 20) return null;
  return `${normalized}@s.whatsapp.net`;
}

function resolveExplicit(raw: string, platform: string): ResolvedUser | null {
  if (platform === 'discord') {
    if (!/^\d{5,24}$/.test(raw)) return null;
    return { jid: raw, display: raw, source: 'discord' };
  }

  if (raw.includes('@')) {
    if (!raw.endsWith('@s.whatsapp.net') && !raw.endsWith('@lid')) return null;
    return { jid: raw, display: bareId(raw), source: raw.endsWith('@lid') ? 'lid' : 'jid' };
  }

  if (isPureDigits(raw)) {
    const jid = phoneToJid(raw);
    return jid ? { jid, display: bareId(jid), source: 'phone' } : null;
  }

  return null;
}

export function resolveTargetUser(
  args: Record<string, unknown>,
  ctx: MessageContext,
  argName: string = 'user',
): ResolvedUser | null {
  const raw = typeof args[argName] === 'string' ? args[argName].trim() : '';
  const sentinel = raw.toLowerCase();

  if (!raw || sentinel === 'mentioned' || sentinel === 'quoted') {
    if (sentinel !== 'quoted' && ctx.mentionedIds?.[0]) {
      const id = ctx.mentionedIds[0];
      return { jid: id, display: ctx.platform === 'discord' ? id : bareId(id), source: 'mention' };
    }
    if (sentinel !== 'mentioned' && ctx.quoted?.senderId) {
      const id = ctx.quoted.senderId;
      return { jid: id, display: ctx.platform === 'discord' ? id : bareId(id), source: 'quoted' };
    }
    return null;
  }

  return resolveExplicit(raw, ctx.platform);
}

export function resolveAllTargetUsers(
  args: Record<string, unknown>,
  ctx: MessageContext,
  argName: string = 'user',
): ResolvedUser[] {
  const raw = typeof args[argName] === 'string' ? args[argName].trim().toLowerCase() : '';
  if ((!raw || raw === 'mentioned') && ctx.mentionedIds && ctx.mentionedIds.length > 1) {
    return ctx.mentionedIds.map(id => ({
      jid: id,
      display: ctx.platform === 'discord' ? id : bareId(id),
      source: 'mention' as const,
    }));
  }
  const single = resolveTargetUser(args, ctx, argName);
  return single ? [single] : [];
}
