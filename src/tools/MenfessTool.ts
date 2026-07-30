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
import { FlowHandler } from '../core/FlowHandler';
import { SessionManager } from '../utils/SessionManager';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'MenfessTool' });

type MenfessArgs = {
  target?: string;
  message?: string;
};

type MenfessFlowData = {
  targetChatId: string;
  message: string;
};

function isMenfessFlowData(value: unknown): value is MenfessFlowData {
  return typeof value === 'object'
    && value !== null
    && 'targetChatId' in value
    && typeof (value as { targetChatId?: unknown }).targetChatId === 'string'
    && 'message' in value
    && typeof (value as { message?: unknown }).message === 'string';
}

/** Parse MENFESS_TARGETS env var into a name->chatId map. */
function loadTargetAliases(): Map<string, string> {
  const map = new Map<string, string>();
  const raw = process.env.MENFESS_TARGETS || '';

  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    const [name, chatId] = trimmed.split(':').map((segment) => segment.trim());
    if (name && chatId) {
      map.set(name.toLowerCase(), chatId);
      continue;
    }

    if (trimmed.includes('@g.us') || trimmed.includes('@s.whatsapp.net')) {
      map.set(trimmed.toLowerCase(), trimmed);
    }
  }

  return map;
}

const targetAliases = loadTargetAliases();

/** Resolve target: check alias map first, then treat input as raw chat ID. */
function resolveTarget(input: string): string | null {
  const alias = targetAliases.get(input.toLowerCase().trim());
  if (alias) return alias;

  if (input.includes('@g.us') || input.includes('@s.whatsapp.net')) {
    return input.trim();
  }

  return null;
}

// Register the confirmation flow handler once at module load
FlowHandler.register('menfess_confirm', async (ctx, flowData) => {
  const lang = ctx.language ?? 'en';
  const response = ctx.text.trim().toLowerCase();

  if (!isMenfessFlowData(flowData.data)) {
    SessionManager.clear(ctx.senderId, 'menfess_confirm', ctx.platform);
    await ctx.reply(t(lang, 'flow.error', { msg: 'Invalid menfess confirmation state.' }));
    return;
  }

  if (['yes', 'y', 'ya', 'iya', 'yep', 'yup', 'send', 'kirim'].includes(response)) {
    const { targetChatId, message } = flowData.data;
    SessionManager.clear(ctx.senderId, 'menfess_confirm', ctx.platform);

    if (!ctx.forwardMessage) {
      await ctx.reply(t(lang, 'menfess.not_supported'));
      return;
    }

    try {
      await ctx.forwardMessage(targetChatId, `[Anonymous Message]\n\n${message}`);
      log.info({ targetChatId, senderId: ctx.senderId }, 'Anonymous message sent');
      await ctx.reply(t(lang, 'menfess.sent'));
    } catch (err: unknown) {
      log.error({ err, targetChatId }, 'Failed to send anonymous message');
      const errMessage = err instanceof Error ? err.message : 'Unknown error';
      await ctx.reply(t(lang, 'menfess.error', { msg: errMessage }));
    }
  } else {
    SessionManager.clear(ctx.senderId, 'menfess_confirm', ctx.platform);
    await ctx.reply(t(lang, 'menfess.cancelled'));
  }
});

export class MenfessTool extends BaseTool {
  readonly name = 'menfess';
  readonly description = 'Send an anonymous message to a target group/chat. Sender identity is hidden.';
  readonly aliases = ['menfess', 'anon'];
  readonly category = 'fun';
  readonly permissions = 'user';
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

    log.debug({ targetInput, senderId: ctx.senderId }, 'Menfess initiated');

    if (!targetInput) return t(lang, 'menfess.no_target');
    if (!message) return t(lang, 'menfess.no_message');

    const targetChatId = resolveTarget(targetInput);
    if (!targetChatId) {
      return `Unknown target "${targetInput}". Use a valid chat ID or a configured alias. Available aliases: ${Array.from(targetAliases.keys()).join(', ') || 'none configured'}.`;
    }

    SessionManager.set(
      ctx.senderId,
      'menfess_confirm',
      { flow: 'menfess_confirm', step: 'confirm', data: { targetChatId, message } },
      ctx.platform,
      60,
    );

    return t(lang, 'menfess.preview', { message });
  }
}

