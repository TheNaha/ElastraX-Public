import { db } from '../db';
import { chatRooms, reminders } from '../db/schema';
import { asc, eq, lte, and, or, isNull } from 'drizzle-orm';
import { logger } from './logger';
import { t } from './i18n';
import { withCancellableTimeout } from './withTimeout.js';
import {
  canonicalRoomKeyForStoredRoom,
  keyPlatformOf,
  normalizeRoomPlatform,
  providerRoomTargetMismatch,
  remoteRoomIdFromKey,
  remoteRoomIdFromRoomKey,
} from '../messaging/roomKeys';

type SendFn = (chatRoomId: string, text: string, signal?: AbortSignal) => Promise<void>;

const STALE_CLAIM_MS = 2 * 60_000;
const SEND_TIMEOUT_MS = 15_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 5 * 365 * 86_400_000;
const MAX_BATCH_SIZE = 50;
const retryAttempts = new Map<number, number>();

type QueryRows = {
  orderBy?: (value: unknown) => QueryRows;
  limit?: (value: number) => QueryRows;
  all: () => typeof reminders.$inferSelect[];
};

function collectRows(query: unknown, limit: number): typeof reminders.$inferSelect[] {
  const typed = query as QueryRows;
  const ordered = typeof typed.orderBy === 'function' ? typed.orderBy(asc(reminders.remindAt)) : typed;
  const bounded = typeof ordered.limit === 'function' ? ordered.limit(limit) : ordered;
  return bounded.all();
}

type ReminderTarget = {
  roomKey: string;
  remoteRoomId: string;
  language: string | null;
  /** Set when the stored room reference cannot be delivered on this platform. */
  mismatch: string | null;
};

/**
 * A reminder row carries both identities: `room_key` (canonical) and
 * `chat_room_id` (the raw provider room id, kept for rollback).  Room config is
 * read with the key, providers receive the raw id, and a key that addresses
 * another platform is refused instead of being sent.
 */
function resolveReminderTarget(reminder: typeof reminders.$inferSelect): ReminderTarget {
  const platform = normalizeRoomPlatform(reminder.platform) ?? 'whatsapp';
  const stored = String(reminder.chatRoomId ?? '');
  const roomKey = reminder.roomKey?.trim() || canonicalRoomKeyForStoredRoom(platform, stored);
  const remoteRoomId = remoteRoomIdFromRoomKey(platform, stored);
  const keyPlatform = keyPlatformOf(roomKey);
  const keyRemote = remoteRoomIdFromKey(roomKey);
  const mismatch = remoteRoomId === null
    ? `reminder ${reminder.id} targets ${stored}, which is not a ${platform} room`
    : keyPlatform === null
      ? providerRoomTargetMismatch(platform, roomKey, remoteRoomId)
      : keyPlatform !== platform
        ? `reminder ${reminder.id} is keyed for ${keyPlatform} but stored as ${platform}`
        : keyRemote !== remoteRoomId
          ? `reminder ${reminder.id} is keyed for ${keyRemote} but stores ${remoteRoomId}`
          : null;
  return {
    roomKey,
    remoteRoomId: remoteRoomId ?? stored,
    language: reminder.language ?? languageForRoomKey(roomKey, platform),
    mismatch,
  };
}

/** Room language keyed on the canonical room key, tolerating raw-id rows. */
function languageForRoomKey(roomKey: string, platform: string): string | null {
  const remote = remoteRoomIdFromKey(roomKey);
  try {
    const byKey = db.select({ language: chatRooms.language })
      .from(chatRooms)
      .where(eq(chatRooms.roomKey, roomKey))
      .all()[0];
    if (byKey?.language) return byKey.language;
    for (const candidate of remote ? [remote] : [roomKey]) {
      const row = db.select({ language: chatRooms.language })
        .from(chatRooms)
        .where(eq(chatRooms.id, candidate))
        .all()[0];
      if (row?.language) return row.language;
    }
  } catch (error) {
    logger.warn({ err: error, roomKey, platform }, '[Scheduler] Room configuration lookup failed');
  }
  return null;
}

function nextMonthly(lastFire: Date, anchorDay: number, now: number): Date | null {
  let year = lastFire.getFullYear();
  let month = lastFire.getMonth();
  for (let count = 0; count < 1_200; count++) {
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const next = new Date(
      year,
      month,
      Math.min(anchorDay, daysInMonth),
      lastFire.getHours(),
      lastFire.getMinutes(),
      lastFire.getSeconds(),
      lastFire.getMilliseconds(),
    );
    if (next.getTime() > now) return next;
  }
  return null;
}

export function computeNextOccurrence(
  lastFire: Date,
  recurrence: string,
  anchorDay: number = lastFire.getDate(),
): Date | null {
  const lower = recurrence.toLowerCase().trim();
  const now = Date.now();

  if (lower === 'monthly') {
    return nextMonthly(lastFire, anchorDay, now);
  }

  let intervalMs: number;
  if (lower === 'hourly') intervalMs = 3_600_000;
  else if (lower === 'daily') intervalMs = 86_400_000;
  else if (lower === 'weekly') intervalMs = 7 * 86_400_000;
  else {
    const match = lower.match(/^every\s+(\d+(?:\.\d+)?)\s*(m|min|minutes?|h|hours?|d|days?)$/);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = match[2]![0];
    intervalMs = amount * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
  }

  if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) return null;
  const base = lastFire.getTime();
  const steps = Math.max(1, Math.floor((now - base) / intervalMs) + 1);
  const next = base + steps * intervalMs;
  if (!Number.isSafeInteger(next) || next > 8_640_000_000_000_000) return null;
  return new Date(next);
}

export function isValidRecurrence(recurrence: string): boolean {
  try {
    return computeNextOccurrence(new Date(), recurrence) !== null;
  } catch {
    return false;
  }
}

export class Scheduler {
  private static senders = new Map<string, SendFn>();
  private static timer: ReturnType<typeof setInterval> | null = null;
  private static processing = false;
  private static stopped = false;

  static registerSender(platform: string, fn: SendFn): void {
    this.senders.set(platform, fn);
  }

  static unregisterSender(platform: string): void {
    this.senders.delete(platform);
  }

  static start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.processReminders().catch(error => logger.error({ err: error }, 'Reminder processing failed'));
    this.timer = setInterval(() => {
      void this.processReminders().catch(error => logger.error({ err: error }, 'Reminder processing failed'));
    }, 30_000);
    this.timer.unref?.();
  }

  static stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private static async processReminders(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;
    try {
      const now = new Date();
      const staleClaimCutoff = new Date(now.getTime() - STALE_CLAIM_MS);
      const due = collectRows(
        db.select()
          .from(reminders)
          .where(and(
            lte(reminders.remindAt, now),
            eq(reminders.isSent, false),
            or(isNull(reminders.claimedAt), lte(reminders.claimedAt, staleClaimCutoff)),
          )),
        MAX_BATCH_SIZE,
      );

      for (const reminder of due) {
        if (this.stopped) break;
        const claimTime = new Date();
        const claim = db.update(reminders)
          .set({ claimedAt: claimTime })
          .where(and(
            eq(reminders.id, reminder.id),
            eq(reminders.isSent, false),
            or(isNull(reminders.claimedAt), lte(reminders.claimedAt, staleClaimCutoff)),
          ))
          .run() as unknown as { changes: number };
        if (claim.changes === 0) continue;

        try {
          const sender = this.senders.get(reminder.platform);
          if (!sender) {
            this.releaseClaim(reminder.id, new Date());
            continue;
          }

          const target = resolveReminderTarget(reminder);
          if (target.mismatch) {
            this.releaseClaim(reminder.id, new Date());
            logger.error({ id: reminder.id, roomKey: target.roomKey, reason: target.mismatch }, 'Reminder delivery refused');
            continue;
          }

          const message = t(target.language ?? 'en', 'reminder.fired', {
            name: reminder.senderName,
            message: reminder.message,
          });
          // Providers receive the raw remote room id, never the canonical key.
          await withCancellableTimeout(
            signal => sender(target.remoteRoomId, message, signal),
            SEND_TIMEOUT_MS,
            'scheduler send',
          );

          if (reminder.recurrence) {
            const anchorDay = 'anchorDay' in reminder && Number.isInteger(reminder.anchorDay)
              ? Number(reminder.anchorDay)
              : reminder.remindAt.getDate();
            const nextFire = computeNextOccurrence(reminder.remindAt, reminder.recurrence, anchorDay);
            if (!nextFire) {
              db.update(reminders)
                .set({ isSent: true, claimedAt: null })
                .where(eq(reminders.id, reminder.id))
                .run();
              logger.error({ id: reminder.id, recurrence: reminder.recurrence }, 'Invalid recurrence; reminder retired');
              continue;
            }
            db.update(reminders)
              .set({ remindAt: nextFire, claimedAt: null })
              .where(eq(reminders.id, reminder.id))
              .run();
            retryAttempts.delete(reminder.id);
          } else {
            db.update(reminders)
              .set({ isSent: true, claimedAt: null })
              .where(eq(reminders.id, reminder.id))
              .run();
            retryAttempts.delete(reminder.id);
          }
        } catch (err) {
          const attempt = (retryAttempts.get(reminder.id) ?? 0) + 1;
          retryAttempts.set(reminder.id, attempt);
          const backoffMs = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempt - 1, 7));
          this.releaseClaim(reminder.id, new Date(Date.now() + backoffMs));
          logger.error({ err, id: reminder.id, attempt }, 'Reminder delivery failed');
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private static releaseClaim(id: number, nextAttempt: Date): void {
    db.update(reminders)
      .set({ claimedAt: null, remindAt: nextAttempt })
      .where(and(eq(reminders.id, id), eq(reminders.isSent, false)))
      .run();
  }
}
