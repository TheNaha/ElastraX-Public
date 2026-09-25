/**
 * @file src/tools/ReminderTool.ts
 * @description Personal reminder / scheduler tool.
 *
 * Allows users to set, list, and cancel reminders. The AI parses natural language
 * time expressions ("in 30 minutes", "tomorrow at 3pm") and this tool persists
 * the reminders to the database. The Scheduler fires them at the right time.
 *
 * Both slash-command and conversational invocation are fully supported:
 *   Slash:          /remind in 30 minutes take your medication
 *   Conversational: "remind me in 30 minutes to take my medication"
 *
 * The `action` parameter lets the LLM also list and cancel reminders without
 * the user having to know separate commands.
 *
 * Slash command aliases: /remind, /reminder
 */

import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { db } from '../db';
import { reminders } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { isValidRecurrence } from '../utils/Scheduler';

const log = logger.child({ module: 'ReminderTool' });
const MIN_REMINDER_DELAY_MS = 1_000;
const MAX_REMINDER_HORIZON_MS = 5 * 365 * 86_400_000;
const MAX_ACTIVE_REMINDERS = 100;
const MAX_REMINDER_MESSAGE_LENGTH = 1_000;

type ActiveReminder = typeof reminders.$inferSelect;

type QueryRows = {
  limit?: (value: number) => QueryRows;
  all: () => unknown[];
};

function collectRows(query: unknown, limit: number): unknown[] {
  const typed = query as QueryRows;
  const bounded = typeof typed.limit === 'function' ? typed.limit(limit) : typed;
  return bounded.all();
}
type ReminderArgs = ToolArgs & {
  action?: 'set' | 'list' | 'cancel' | string;
  time?: string;
  message?: string;
  number?: string;
  recurrence?: string;
};

/**
 * Parses a natural-language time string relative to now.
 * Returns a Date or null if unparseable.
 *
 * Handles:
 *   "in X minutes/hours/days"
 *   "X minutes/hours/days"  (implicit "in")
 *   "tomorrow [at HH:MM]"
 *   "at HH:MM" / "HH:MM" (today or tomorrow if time is past)
 *   ISO strings
 */
export function parseRelativeTime(input: string): Date | null {
  const now = Date.now();
  const lower = input.toLowerCase().trim();
  const relativeMatch = lower.match(/^(?:in\s+)?(\d+(?:\.\d+)?)\s*(minute|min|hour|hr|day|second|sec)s?$/);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2]!;
    const duration = unit.startsWith('sec')
      ? amount * 1_000
      : unit.startsWith('min')
        ? amount * 60_000
        : unit.startsWith('hour') || unit === 'hr'
          ? amount * 3_600_000
          : amount * 86_400_000;
    if (!Number.isFinite(duration) || duration < MIN_REMINDER_DELAY_MS || duration > MAX_REMINDER_HORIZON_MS) return null;
    return new Date(now + duration);
  }

  if (lower.startsWith('tomorrow')) {
    const timeMatch = lower.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
    const date = new Date(now);
    date.setDate(date.getDate() + 1);
    if (timeMatch) {
      let hours = Number(timeMatch[1]);
      const minutes = Number(timeMatch[2]);
      const hasMeridiem = Boolean(timeMatch[3]);
    if ((hasMeridiem && (hours < 1 || hours > 12)) || (!hasMeridiem && (hours < 0 || hours > 23)) || minutes < 0 || minutes > 59) return null;
      if (timeMatch[3]?.toLowerCase() === 'pm' && hours < 12) hours += 12;
      if (timeMatch[3]?.toLowerCase() === 'am' && hours === 12) hours = 0;
      date.setHours(hours, minutes, 0, 0);
    } else {
      date.setHours(9, 0, 0, 0);
    }
    const delay = date.getTime() - now;
    return delay >= MIN_REMINDER_DELAY_MS && delay <= MAX_REMINDER_HORIZON_MS ? date : null;
  }

  const timeMatch = lower.match(/^(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (timeMatch) {
    let hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2]);
    const hasMeridiem = Boolean(timeMatch[3]);
    if ((hasMeridiem && (hours < 1 || hours > 12)) || (!hasMeridiem && (hours < 0 || hours > 23)) || minutes < 0 || minutes > 59) return null;
    if (timeMatch[3]?.toLowerCase() === 'pm' && hours < 12) hours += 12;
    if (timeMatch[3]?.toLowerCase() === 'am' && hours === 12) hours = 0;
    const date = new Date(now);
    date.setHours(hours, minutes, 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    const delay = date.getTime() - now;
    return delay >= MIN_REMINDER_DELAY_MS && delay <= MAX_REMINDER_HORIZON_MS ? date : null;
  }

  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) return null;
  const delay = timestamp - now;
  return delay >= MIN_REMINDER_DELAY_MS && delay <= MAX_REMINDER_HORIZON_MS ? new Date(timestamp) : null;
}

function formatTime(date: Date): string {
  return date.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export class ReminderTool extends BaseTool<ReminderArgs> {
  readonly name = 'reminder';
  readonly description = 'Set, list, or cancel reminders. Supports natural time parsing and recurring schedules.';
  readonly aliases = ['remind', 'reminder'];
  readonly category = 'utility';
  readonly permissions = 'user';
  override readonly triggerPatterns = [/\b(remind|ingatkan|reminder|alarm|timer|waktu)\b/i];

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
              enum: ['set', 'list', 'cancel'],
              description: '"set" to create a reminder, "list" to view active reminders, "cancel" to delete one by number.',
            },
            time: {
              type: 'string',
              description: 'When to fire the reminder. Examples: "in 30 minutes", "tomorrow at 3pm", "at 18:00". Required for action=set.',
            },
            message: {
              type: 'string',
              description: 'What to remind the user about. Required for action=set.',
            },
            number: {
              type: 'string',
              description: 'The reminder number to cancel (from the "list" output). Required for action=cancel.',
            },
            recurrence: {
              type: 'string',
              description: 'Optional recurrence pattern for repeating reminders. Examples: "daily", "weekly", "monthly", "hourly", "every 30m", "every 2h", "every 7d". Omit for one-shot reminders.',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  async execute(args: ReminderArgs, ctx: MessageContext): Promise<string> {
    let { action, time, message } = args;
    const { number, recurrence } = args;
    const lang = ctx.language ?? 'en';

    log.debug({ action, chatId: ctx.chatId, senderId: ctx.senderId }, 'Reminder action requested');

    // Slash shorthand support:
    // /remind in 30 minutes take a break
    // With positional parsing, this often arrives as action='in', time='30', message='minutes'
    // For command path we normalize unknown action to 'set'.
    const validActions = new Set(['set', 'list', 'cancel']);
    if (!validActions.has(String(action))) {
      const cmd = String(args.__command || '').toLowerCase();
      if (cmd === 'remind' || cmd === 'reminder') {
        const original = [action, time, message, number].filter(Boolean).join(' ').trim();
        action = 'set';

        // Heuristic split around " to " (e.g., "in 30 minutes to call mom")
        const toIdx = original.toLowerCase().indexOf(' to ');
        if (toIdx > 0) {
          time = original.slice(0, toIdx).trim();
          message = original.slice(toIdx + 4).trim();
        } else {
          // fallback: first 2 tokens as time, rest as message
          const parts = original.split(/\s+/);
          time = parts.slice(0, 2).join(' ');
          message = parts.slice(2).join(' ');
        }
      }
    }

    // ── LIST ───────────────────────────────────────────────────────────────────
    if (action === 'list') {
      const active = collectRows(
        db.select()
          .from(reminders)
          .where(and(
            eq(reminders.senderId, ctx.senderId),
            eq(reminders.platform, ctx.platform),
            eq(reminders.isSent, false),
          ))
          .orderBy(reminders.remindAt),
        MAX_ACTIVE_REMINDERS,
      ) as ActiveReminder[];

      log.debug({ senderId: ctx.senderId, activeCount: active.length }, 'Listing reminders');

      if (active.length === 0) {
        return t(lang, 'reminder.list_empty');
      }

      const items = active.map((r, i) => {
        const baseItem = t(lang, 'reminder.list_item', {
          n: String(i + 1),
          message: r.message,
          time: formatTime(r.remindAt),
        }) + ` (#${r.id})`;
        // Append recurrence info if present
        return r.recurrence
          ? baseItem + t(lang, 'reminder.recurrence_info', { recurrence: r.recurrence })
          : baseItem;
      }).join('\n\n');

      return t(lang, 'reminder.list', { items });
    }

    // ── CANCEL ─────────────────────────────────────────────────────────────────
    if (action === 'cancel') {
      // Accept either the list position or the stable reminder id shown as "(#<id>)".
      const normalizedNumber = String(number || '').replace(/^#/, '').trim();
      if (!/^\d+$/.test(normalizedNumber)) return t(lang, 'reminder.cancel_invalid');
      const n = Number(normalizedNumber);
      if (!Number.isSafeInteger(n) || n < 1) return t(lang, 'reminder.cancel_invalid');

      const active = collectRows(
        db.select()
          .from(reminders)
          .where(and(
            eq(reminders.senderId, ctx.senderId),
            eq(reminders.platform, ctx.platform),
            eq(reminders.isSent, false),
          ))
          .orderBy(reminders.remindAt),
        MAX_ACTIVE_REMINDERS,
      ) as ActiveReminder[];

      // Exact id match wins (stable across list changes); fall back to position.
      const target = active.find(r => r.id === n)
        ?? (n <= active.length ? active[n - 1] : undefined);
      if (!target) return t(lang, 'reminder.cancel_invalid');

      db.delete(reminders).where(eq(reminders.id, target.id)).run();
      log.info({ senderId: ctx.senderId, reminderId: target.id }, 'Reminder cancelled');
      return t(lang, 'reminder.cancel', { n: String(n) });
    }

    // ── SET ────────────────────────────────────────────────────────────────────
    if (!time) return t(lang, 'reminder.invalid_time');
    if (!message) return t(lang, 'reminder.no_message', {});
    const reminderMessage = String(message).trim();
    if (!reminderMessage || reminderMessage.length > MAX_REMINDER_MESSAGE_LENGTH) {
      return t(lang, 'reminder.error', { msg: 'Message must contain 1-1000 characters' });
    }

    const fireAt = parseRelativeTime(time);
    if (!fireAt) {
      return t(lang, 'reminder.invalid_time');
    }

    // Reject recurrence patterns the Scheduler would silently retire at fire time.
    if (recurrence && (!isValidRecurrence(String(recurrence).trim()) || String(recurrence).length > 64)) {
      return t(lang, 'reminder.invalid_recurrence', { recurrence: String(recurrence).slice(0, 64) });
    }

    const active = collectRows(
      db.select({ id: reminders.id })
        .from(reminders)
        .where(and(
          eq(reminders.senderId, ctx.senderId),
          eq(reminders.platform, ctx.platform),
          eq(reminders.isSent, false),
        )),
      MAX_ACTIVE_REMINDERS + 1,
    ) as Array<{ id: number }>;
    if (active.length >= MAX_ACTIVE_REMINDERS) {
      return t(lang, 'reminder.error', { msg: `Maximum ${MAX_ACTIVE_REMINDERS} active reminders reached` });
    }

    try {
      db.insert(reminders).values({
        chatRoomId: ctx.chatId,
        senderId: ctx.senderId,
        senderName: ctx.senderName,
        message: reminderMessage,
        remindAt: fireAt,
        isSent: false,
        platform: ctx.platform,
        recurrence: recurrence ? String(recurrence).trim() : null,
        language: ctx.language ?? 'en',
        created_at: new Date(),
      }).run();

      log.info({ senderId: ctx.senderId, chatId: ctx.chatId, remindAt: fireAt.toISOString(), recurrence: recurrence || null }, 'Reminder set');

      if (recurrence) {
        return t(lang, 'reminder.recurrence_set', {
          time: formatTime(fireAt),
          message: reminderMessage,
          recurrence: String(recurrence),
        });
      }

      return t(lang, 'reminder.set', {
        time: formatTime(fireAt),
        message: reminderMessage,
      });
    } catch (error: unknown) {
      log.error({ err: error, senderId: ctx.senderId }, 'Failed to insert reminder');
      return t(lang, 'reminder.error', { msg: 'Unable to create reminder' });
    }
  }
}

