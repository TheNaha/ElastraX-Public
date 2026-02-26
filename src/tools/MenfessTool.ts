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
 *   → AI calls menfess(target_chat_id, message)
 *   → Bot previews and asks for confirmation
 *   → User replies "yes" → message is forwarded with no sender attribution
 *
 * Slash command usage:
 *   /menfess [target_chat_id] [message]
 *
 * The target_chat_id can be:
 *   - A WhatsApp group JID (use /id in the target group to find it)
 *   - A keyword alias (the bot owner can pre-configure in env: MENFESS_TARGETS)
 *     e.g., MENFESS_TARGETS=family:120363xxxxxx@g.us,friends:120363yyyyyy@g.us
 *
 * Slash command aliases: /menfess, /anon
 */

import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { FlowHandler } from '../core/FlowHandler';
import { SessionManager } from '../utils/SessionManager';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';

/** Parse MENFESS_TARGETS env var into a name→chatId map. */
function loadTargetAliases(): Map<string, string> {
  const map = new Map<string, string>();
  const raw = process.env.MENFESS_TARGETS || '';
  for (const pair of raw.split(',')) {
    const [name, chatId] = pair.split(':').map(s => s.trim());
    if (name && chatId) map.set(name.toLowerCase(), chatId);
  }
  return map;
}

const targetAliases = loadTargetAliases();

/** Resolve target: check alias map first, then treat input as raw chat ID. */
function resolveTarget(input: string): string | null {
  const alias = targetAliases.get(input.toLowerCase().trim());
  if (alias) return alias;
  // Accept raw WhatsApp JIDs
  if (input.includes('@g.us') || input.includes('@s.whatsapp.net')) return input.trim();
  return null;
}

// Register the confirmation flow handler once at module load
FlowHandler.register('menfess_confirm', async (ctx, flowData) => {
  const lang = ctx.language ?? 'en';
  const response = ctx.text.trim().toLowerCase();

  if (['yes', 'y', 'ya', 'iya', 'yep', 'yup', 'send', 'kirim'].includes(response)) {
    const { targetChatId, message } = flowData.data;
    SessionManager.clear(ctx.senderId, 'menfess_confirm', ctx.platform);

    if (!ctx.forwardMessage) {
      await ctx.reply(t(lang, 'menfess.not_supported'));
      return;
    }

    try {
      // Build an anonymous message — we send it directly to the target chat
      // Providers expose forwardMessage which sends the current message content to another chat
      // For menfess, we compose a fresh message rather than forwarding the original
      // This is handled by the provider; here we just trigger the action
      await ctx.forwardMessage(targetChatId, `📬 *Anonymous Message:*\n\n${message}`);
      await ctx.reply(t(lang, 'menfess.sent'));
    } catch (err: any) {
      logger.error({ err }, '[MenfessTool] Failed to send anonymous message');
      await ctx.reply(t(lang, 'menfess.error', { msg: err.message }));
    }
  } else {
    SessionManager.clear(ctx.senderId, 'menfess_confirm', ctx.platform);
    await ctx.reply(t(lang, 'menfess.cancelled'));
  }
});

export class MenfessTool extends BaseTool {
  readonly name = 'menfess';
  readonly description = 'Send an anonymous (menfess) message to a target group or chat. The actual sender is hidden. Requires the target chat ID or a configured alias. A confirmation step is shown before sending.';
  readonly aliases = ['menfess', 'anon'];
  readonly category = 'fun';
  readonly permissions = 'user';

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

  async execute(args: Record<string, any>, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    const targetInput = String(args.target || '').trim();
    const message = String(args.message || '').trim();

    if (!targetInput) return t(lang, 'menfess.no_target');
    if (!message) return t(lang, 'menfess.no_message');

    const targetChatId = resolveTarget(targetInput);
    if (!targetChatId) {
      return `❌ Unknown target "${targetInput}". Use a valid chat ID or a configured alias. Available aliases: ${Array.from(targetAliases.keys()).join(', ') || 'none configured'}.`;
    }

    // Start confirmation flow
    SessionManager.set(
      ctx.senderId,
      'menfess_confirm',
      { flow: 'menfess_confirm', step: 'confirm', data: { targetChatId, message } },
      ctx.platform,
      60, // 60-second window to confirm
    );

    return t(lang, 'menfess.preview', { message });
  }
}
