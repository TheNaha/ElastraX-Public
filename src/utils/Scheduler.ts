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

        // Mark as sent
        db.update(reminders)
          .set({ isSent: true })
          .where(eq(reminders.id, reminder.id))
          .run();

        logger.info({ id: reminder.id, chatRoomId: reminder.chatRoomId }, '[Scheduler] Reminder delivered');
      } catch (err) {
        logger.error({ err, id: reminder.id }, '[Scheduler] Failed to deliver reminder');
      }
    }
  }
}
