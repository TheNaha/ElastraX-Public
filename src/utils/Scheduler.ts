/**
 * @file src/utils/Scheduler.ts
 * @description Background task scheduler for persistent reminders.
 *
 * Polls the `reminders` database table every minute and fires any reminders
 * whose `remind_at` timestamp has passed. Fired reminders are marked as sent
 * so they are never delivered twice, even across restarts.
 *
 * The scheduler requires a `sendCallback` to be registered by the provider layer
 * so it can send messages back to the chat room. Multiple providers can register
 * callbacks; the scheduler picks the one matching the reminder's platform.
 *
 * Usage (in src/index.ts after providers start):
 * ```ts
 * Scheduler.registerSender('whatsapp', (chatId, text) => waProvider.sendMessage(chatId, text));
 * Scheduler.start();
 * ```
 */

import { db } from '../db';
import { reminders } from '../db/schema';
import { eq, lte, and } from 'drizzle-orm';
import { logger } from './logger';
import { t } from './i18n';

type SendFn = (chatRoomId: string, text: string) => Promise<void>;

export class Scheduler {
  private static senders = new Map<string, SendFn>();
  private static timer: ReturnType<typeof setInterval> | null = null;

  /** Register a send callback for a given platform. */
  static registerSender(platform: string, fn: SendFn): void {
    this.senders.set(platform, fn);
    logger.info({ platform }, '[Scheduler] Sender registered');
  }

  /** Start the background polling loop (every 30 seconds). */
  static start(): void {
    if (this.timer) return; // already running
    this.timer = setInterval(() => {
      this.processReminders().catch(err => {
        logger.error({ err }, '[Scheduler] Error in reminder loop');
      });
    }, 30_000);
    logger.info('[Scheduler] Started (polling every 30s)');
  }

  /** Stop the background loop (called on graceful shutdown). */
  static stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Process all overdue reminders in a single batch. */
  private static async processReminders(): Promise<void> {
    const now = new Date();

    const due = db.select()
      .from(reminders)
      .where(and(lte(reminders.remindAt, now), eq(reminders.isSent, false)))
      .all();

    if (due.length === 0) return;

    logger.info({ count: due.length }, '[Scheduler] Processing due reminders');

    for (const reminder of due) {
      try {
        const sender = this.senders.get(reminder.platform);
        if (!sender) {
          logger.warn({ platform: reminder.platform, id: reminder.id }, '[Scheduler] No sender for platform, skipping');
          continue;
        }

        const message = t('en', 'reminder.fired', {
          name: reminder.senderName,
          message: reminder.message,
        });

        await sender(reminder.chatRoomId, message);

        // Handle recurring reminders: reschedule instead of marking as sent
        if (reminder.recurrence) {
          const nextFire = this.computeNextOccurrence(reminder.remindAt, reminder.recurrence);
          if (nextFire) {
            db.update(reminders)
              .set({ remindAt: nextFire })
              .where(eq(reminders.id, reminder.id))
              .run();
            logger.info({ id: reminder.id, nextFire }, '[Scheduler] Recurring reminder rescheduled');
          } else {
            // Invalid recurrence, mark as sent
            db.update(reminders)
              .set({ isSent: true })
              .where(eq(reminders.id, reminder.id))
              .run();
          }
        } else {
          // One-shot reminder: mark as sent
          db.update(reminders)
            .set({ isSent: true })
            .where(eq(reminders.id, reminder.id))
            .run();
        }

        logger.info({ id: reminder.id, chatRoomId: reminder.chatRoomId }, '[Scheduler] Reminder delivered');
      } catch (err) {
        logger.error({ err, id: reminder.id }, '[Scheduler] Failed to deliver reminder');
      }
    }
  }

  /**
   * Compute the next occurrence based on a simple recurrence pattern.
   * Supported patterns: 'daily', 'weekly', 'monthly', 'hourly',
   * or 'every Xm/Xh/Xd' (e.g., 'every 30m', 'every 2h', 'every 7d').
   */
  private static computeNextOccurrence(lastFire: Date, recurrence: string): Date | null {
    const lower = recurrence.toLowerCase().trim();
    const base = lastFire.getTime();
    const now = Date.now();

    let intervalMs = 0;

    switch (lower) {
      case 'hourly':
        intervalMs = 3_600_000;
        break;
      case 'daily':
        intervalMs = 86_400_000;
        break;
      case 'weekly':
        intervalMs = 7 * 86_400_000;
        break;
      case 'monthly': {
        const next = new Date(lastFire);
        next.setMonth(next.getMonth() + 1);
        return next;
      }
      default: {
        // Parse 'every Xm', 'every Xh', 'every Xd'
        const match = lower.match(/^every\s+(\d+(?:\.\d+)?)\s*(m|min|minutes?|h|hours?|d|days?)$/i);
        if (match) {
          const amount = parseFloat(match[1]);
          const unit = match[2][0]; // 'm', 'h', or 'd'
          if (unit === 'm') intervalMs = amount * 60_000;
          else if (unit === 'h') intervalMs = amount * 3_600_000;
          else if (unit === 'd') intervalMs = amount * 86_400_000;
        } else {
          return null; // Unrecognized pattern
        }
      }
    }

    if (intervalMs <= 0) return null;

    // Skip forward until the next occurrence is in the future
    let nextFire = base + intervalMs;
    while (nextFire <= now) {
      nextFire += intervalMs;
    }
    return new Date(nextFire);
  }
}
