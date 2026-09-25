/**
 * @file src/tools/MenfessTool.ts
 * @description Anonymous message forwarding (Menfess) tool.
 *
 * Allows users to send anonymous messages to a target group or private chat.
 * The tool uses a one-step confirmation flow: previews the message and asks
 * the user to confirm before sending.
 *
 * Conversational usage:
 *   User DMs: "send anonymous message to the family group: hey wanna hang out?"
 *   -> AI calls menfess(target_chat_id, message)
 *   -> Bot previews and asks for confirmation
 *   -> User replies "yes" -> message is forwarded with no sender attribution
 *
 * Slash command usage:
 *   /menfess [target_chat_id] [message]
 *
 * The target_chat_id can be:
 *   - A WhatsApp group JID (use /id in the target group to find it)
 *   - A keyword alias (the bot owner can pre-configure in env: MENFESS_TARGETS)
 *     e.g., MENFESS_TARGETS=family:120363xxxxxx@g.us,friends:120363yyyyyy@g.us
 *   - A raw JID listed directly in MENFESS_TARGETS for allow-list style config
 *
 * Slash command aliases: /menfess, /anon
 */

import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { FlowHandler, type FlowSession } from '../core/FlowHandler';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';

const log = logger.child({ module: 'MenfessTool' });

type MenfessArgs = {
  target?: string;
  message?: string;
};

type MenfessFlowData = {
  targetChatId: string;
  targetLabel: string;
  message: string;
  sourceRoomId: string;
  platform: string;
  directSend: true;
};

function isMenfessFlowData(value: unknown): value is MenfessFlowData {
  return typeof value === 'object'
    && value !== null
    && 'targetChatId' in value
    && typeof (value as { targetChatId?: unknown }).targetChatId === 'string'
    && 'message' in value
    && typeof (value as { message?: unknown }).message === 'string'
    && 'sourceRoomId' in value
    && typeof (value as { sourceRoomId?: unknown }).sourceRoomId === 'string'
    && (value as { directSend?: unknown }).directSend === true;
}

export function loadTargetAliases(): Map<string, string> {
  const map = new Map<string, string>();
  const raw = process.env.MENFESS_TARGETS || '';
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    if (/^\d+@(g\.us|s\.whatsapp\.net)$/i.test(trimmed)) {
      map.set(trimmed.toLowerCase(), trimmed);
      continue;
    }
    const separator = trimmed.indexOf(':');
    if (separator > 0) {
      const name = trimmed.slice(0, separator).trim().toLowerCase();
      const chatId = trimmed.slice(separator + 1).trim();
      if (name && chatId) map.set(name, chatId);
    }
  }
  return map;
}

export function isMenfessTargetAllowed(input: string): boolean {
  return loadTargetAliases().has(input.trim().toLowerCase());
}

export const isTargetAllowed = isMenfessTargetAllowed;

export function resolveTarget(input: string, aliases = loadTargetAliases()): string | null {
  return aliases.get(input.trim().toLowerCase()) ?? null;
}

// ── Flow Processor ──────────────────────────────────────────────────

export const menfessConfirmFlowProcessor = async (ctx: MessageContext, flowData: FlowSession) => {
  const lang = ctx.language ?? 'en';
  const response = ctx.text.trim().toLowerCase();

  if (!isMenfessFlowData(flowData.data)) {
    await FlowHandler.clearSession(ctx.senderId, 'menfess_confirm', ctx.platform, ctx.chatId);
    await ctx.reply(t(lang, 'flow.error', { msg: 'Invalid menfess confirmation state.' }));
    return;
  }
  if (flowData.data.sourceRoomId !== ctx.chatId || flowData.data.platform !== ctx.platform) {
    await FlowHandler.clearSession(ctx.senderId, 'menfess_confirm', ctx.platform, ctx.chatId);
    await ctx.reply(t(lang, 'menfess.error', { msg: 'The confirmation must be sent in the original chat.' }));
    return;
  }

  if (['yes', 'y', 'ya', 'iya', 'yep', 'yup', 'send', 'kirim'].includes(response)) {
    const { targetChatId, message, targetLabel } = flowData.data;
    const resolvedTarget = resolveTarget(targetLabel);
    if (!resolvedTarget || resolvedTarget !== targetChatId) {
      await FlowHandler.clearSession(ctx.senderId, 'menfess_confirm', ctx.platform, ctx.chatId);
      await ctx.reply(t(lang, 'menfess.error', { msg: 'The destination is no longer allowlisted.' }));
      return;
    }
    if (!ctx.forwardMessage) {
      await FlowHandler.clearSession(ctx.senderId, 'menfess_confirm', ctx.platform, ctx.chatId);
      await ctx.reply(t(lang, 'menfess.not_supported'));
      return;
    }
    try {
      await ctx.forwardMessage(targetChatId, `[Anonymous Message]\n\n${message}`);
      await FlowHandler.clearSession(ctx.senderId, 'menfess_confirm', ctx.platform, ctx.chatId);
      log.info({ targetChatId, senderId: ctx.senderId }, 'Anonymous message sent');
      await ctx.reply(`${t(lang, 'menfess.sent')}\nDestination: ${targetChatId}\nThe platform may still identify the sender; anonymity is not guaranteed.`);
    } catch (err: unknown) {
      await FlowHandler.clearSession(ctx.senderId, 'menfess_confirm', ctx.platform, ctx.chatId);
      log.error({ err, targetChatId }, 'Failed to send anonymous message');
      await ctx.reply(t(lang, 'menfess.error', { msg: getErrorMessage(err) }));
    }
  } else {
    await FlowHandler.clearSession(ctx.senderId, 'menfess_confirm', ctx.platform, ctx.chatId);
    await ctx.reply(t(lang, 'menfess.cancelled'));
  }
};

// ── Tool Class ──────────────────────────────────────────────────────

export class MenfessTool extends BaseTool {
  readonly name = 'menfess';
  readonly description = 'Send an anonymous message to a target group/chat. Sender identity is hidden.';
  readonly aliases = ['menfess', 'anon'];
  readonly category = 'fun';
  readonly permissions = 'user';
  override readonly mutability = 'external-mutation' as const;
  override readonly triggerPatterns = [/\b(menfess|confess|rahasia|anonymous)\b/i];

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              description: 'The target chat ID or configured alias name (e.g., "family", "friends", or a raw WhatsApp JID).',
            },
            message: {
              type: 'string',
              description: 'The anonymous message to send.',
            },
          },
          required: ['target', 'message'],
        },
      },
    };
  }

  async execute(args: MenfessArgs, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    const targetInput = String(args.target || '').trim();
    const message = String(args.message || '').trim();
    const aliases = loadTargetAliases();

    if (!targetInput) return t(lang, 'menfess.no_target');
    if (!message) return t(lang, 'menfess.no_message');
    if (message.length > 4000) return 'Menfess messages are limited to 4000 characters.';

    const targetChatId = resolveTarget(targetInput, aliases);
    if (!targetChatId) {
      return `Unknown target or non-allowlisted destination "${targetInput}". Available destinations: ${Array.from(aliases.keys()).join(', ') || 'none configured'}.`;
    }

    await FlowHandler.setSession(
      ctx.senderId,
      'menfess_confirm',
      { flow: 'menfess_confirm', step: 'confirm', roomId: ctx.chatId, data: { targetChatId, targetLabel: targetInput, message, sourceRoomId: ctx.chatId, platform: ctx.platform, directSend: true } },
      ctx.platform,
      60,
      ctx.chatId,
    );

    return `${t(lang, 'menfess.preview', { message })}\nDestination: ${targetInput} (${targetChatId})\nThe message will be sent as a new direct message only after you confirm. Anonymity is not guaranteed by the platform.`;
  }
}

