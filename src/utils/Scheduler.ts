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
import { eq, lte, and, or, isNull } from 'drizzle-orm';
import { logger } from './logger';
import { t } from './i18n';
import { withTimeout } from './withTimeout.js';

type SendFn = (chatRoomId: string, text: string) => Promise<void>;

/** A claim older than this is considered abandoned (process crashed mid-send) and may be retried. */
const STALE_CLAIM_MS = 2 * 60_000;
/** Hard cap on a single delivery attempt so a hung sender cannot block the loop. */
const SEND_TIMEOUT_MS = 15_000;


/**
 * Compute the next occurrence based on a simple recurrence pattern.
 * Supported patterns: 'hourly', 'daily', 'weekly', 'monthly',
 * or 'every Xm/Xh/Xd' (e.g., 'every 30m', 'every 2h', 'every 7d').
 * Returns null for unrecognized patterns.
 */
export function computeNextOccurrence(lastFire: Date, recurrence: string): Date | null {
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
      // Calendar-aware advance that preserves the day-of-month (Jan 31 -> Feb 28 -> Mar 31)
      // instead of drifting via setMonth overflow.
      const origDay = lastFire.getDate();
      let year = lastFire.getFullYear();
      let month = lastFire.getMonth(); // 0-based
      let next: Date;
      do {
        month += 1;
        if (month > 11) { month = 0; year += 1; }
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        next = new Date(
          year, month, Math.min(origDay, daysInMonth),
          lastFire.getHours(), lastFire.getMinutes(), lastFire.getSeconds(), lastFire.getMilliseconds(),
        );
      } while (next.getTime() <= now);
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

/** True when the recurrence pattern is one computeNextOccurrence understands. */
export function isValidRecurrence(recurrence: string): boolean {
  return computeNextOccurrence(new Date(), recurrence) !== null;
}

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
    const staleClaimCutoff = new Date(now.getTime() - STALE_CLAIM_MS);

    // Only unclaimed rows (or rows whose claim went stale after a crash) are eligible.
    const due = db.select()
      .from(reminders)
      .where(and(
        lte(reminders.remindAt, now),
        eq(reminders.isSent, false),
        or(isNull(reminders.claimedAt), lte(reminders.claimedAt, staleClaimCutoff)),
      ))
      .all();

    if (due.length === 0) return;

    logger.info({ count: due.length }, '[Scheduler] Processing due reminders');

    for (const reminder of due) {
      // Atomic claim: the conditional UPDATE wins exactly once even with
      // concurrent workers; a crash between claim and send is recovered by STALE_CLAIM_MS.
      // (better-sqlite3's run() returns the sqlite RunResult with `changes`, typed as void by drizzle.)
      const claim = db.update(reminders)
        .set({ claimedAt: now })
        .where(and(
          eq(reminders.id, reminder.id),
          eq(reminders.isSent, false),
          or(isNull(reminders.claimedAt), lte(reminders.claimedAt, staleClaimCutoff)),
        ))
        .run() as unknown as { changes: number };
      if (claim.changes === 0) continue; // someone else claimed it meanwhile

      try {
        const sender = this.senders.get(reminder.platform);
        if (!sender) {
          logger.warn({ platform: reminder.platform, id: reminder.id }, '[Scheduler] No sender for platform, skipping');
          // Release the claim so delivery is retried once a sender registers.
          this.releaseClaim(reminder.id);
          continue;
        }

        const message = t(reminder.language ?? 'en', 'reminder.fired', {
          name: reminder.senderName,
          message: reminder.message,
        });

        await withTimeout(sender(reminder.chatRoomId, message), SEND_TIMEOUT_MS, 'scheduler send');

        // Handle recurring reminders: reschedule instead of marking as sent
        if (reminder.recurrence) {
          const nextFire = computeNextOccurrence(reminder.remindAt, reminder.recurrence);
          if (nextFire) {
            db.update(reminders)
              .set({ remindAt: nextFire, claimedAt: null })
              .where(eq(reminders.id, reminder.id))
              .run();
            logger.info({ id: reminder.id, nextFire }, '[Scheduler] Recurring reminder rescheduled');
          } else {
            // Invalid recurrence, mark as sent
            db.update(reminders)
              .set({ isSent: true })
              .where(eq(reminders.id, reminder.id))
              .run();
            logger.warn({ id: reminder.id, recurrence: reminder.recurrence }, '[Scheduler] Unrecognized recurrence — reminder retired');
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
        // Release the claim so the next poll retries delivery.
        this.releaseClaim(reminder.id);
      }
    }
  }

  private static releaseClaim(id: number): void {
    db.update(reminders)
      .set({ claimedAt: null })
      .where(and(eq(reminders.id, id), eq(reminders.isSent, false)))
      .run();
  }
}
