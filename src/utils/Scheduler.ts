import { db } from '../db';
import { chatRooms, reminders } from '../db/schema';
import { asc, eq, lte, and, or, isNull } from 'drizzle-orm';
import { readIntegerEnv } from '../config/runtime';
import { logger } from './logger';
import { t } from './i18n';
import { exponentialBackoff } from './backoff';
import { withCancellableTimeout } from './withTimeout.js';
import {
  canonicalRoomKeyForStoredRoom,
  keyPlatformOf,
  normalizeRoomPlatform,
  providerRoomTargetMismatch,
  remoteRoomIdFromKey,
  remoteRoomIdFromRoomKey,
} from '../messaging/roomKeys';
import { parseAgentTaskMessage } from './scheduledTasks';

type SendFn = (chatRoomId: string, text: string, signal?: AbortSignal) => Promise<void>;

/**
 * Runs an agent instruction on a room's behalf. `instruction` is the reminder
 * text with its marker stripped; the runner owns the policy, the budget and
 * producing the reply.
 */
export type ScheduledTaskFn = (request: {
  platform: string;
  remoteRoomId: string;
  roomKey: string;
  language: string;
  instruction: string;
  signal?: AbortSignal;
}) => Promise<void>;

const STALE_CLAIM_MS = 2 * 60_000;
const SEND_TIMEOUT_MS = 15_000;
const TASK_TIMEOUT_MS = 120_000;
/** Upper bound on catch-up steps when a recurring reminder was missed for a long time. */
const MAX_CATCHUP_STEPS = 400;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 5 * 365 * 86_400_000;
const MAX_BATCH_SIZE = 50;
/** A reminder that cannot be routed is retired after this many failed attempts. */
const MAX_DELIVERY_ATTEMPTS = 5;
/**
 * Attempts allowed when delivery could not even be attempted (no sender for the
 * platform). Much larger than {@link MAX_DELIVERY_ATTEMPTS}: a provider in
 * degraded mode is a temporary state, not a poison payload.
 */
const MAX_DEFER_ATTEMPTS = 24;
/**
 * Send-failure attempts, keyed by reminder id.
 *
 * Kept separate from {@link deferAttempts} on purpose: the two paths have very
 * different ceilings. Sharing one counter meant that after a provider outage had
 * pushed the count past `MAX_DELIVERY_ATTEMPTS` through deferrals, the very first
 * real send failure after recovery retired the reminder immediately.
 */
const retryAttempts = new Map<number, number>();
/** Deferral attempts (could not even attempt delivery), keyed by reminder id. */
const deferAttempts = new Map<number, number>();

/** Clear every in-memory counter for a reminder. */
function clearAttempts(id: number): void {
  retryAttempts.delete(id);
  deferAttempts.delete(id);
}

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

/** Rebuild a Date from `source`'s wall-clock time, with optional date-component overrides. */
function dateFromComponents(
  source: Date,
  overrides: { year?: number; month?: number; date?: number },
): Date {
  return new Date(
    overrides.year ?? source.getFullYear(),
    overrides.month ?? source.getMonth(),
    overrides.date ?? source.getDate(),
    source.getHours(),
    source.getMinutes(),
    source.getSeconds(),
    source.getMilliseconds(),
  );
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
    const next = dateFromComponents(lastFire, { year, month, date: Math.min(anchorDay, daysInMonth) });
    if (next.getTime() > now) return next;
  }
  return null;
}

/**
 * Advance `from` by `days` whole calendar days until the result is strictly in
 * the future, rebuilding the date from local wall-clock components.
 *
 * `hourly`/`daily`/`weekly` used to add a constant millisecond count
 * (`24h`, `7d`). A fixed ms offset is not a calendar day: across a DST boundary
 * the local fire time moves by an hour, so a 09:00 daily reminder ran at 10:00
 * for the whole DST period. `nextMonthly` in this same file already rebuilt the
 * date from components — two implementations of "next occurrence" in one file,
 * disagreeing.
 *
 * The local date is advanced by whole days, then the *original* local clock time
 * is re-applied, so the wall-clock time is preserved across a DST shift.
 *
 * The step is capped at {@link MAX_CATCHUP_STEPS} periods, but the cap must not
 * be able to hand back a date that is still in the past: `processReminders`
 * only checks for `null`, so a stale date would be written back and the
 * reminder would fire again on the very next tick. When the cap is hit the
 * remaining whole periods are added in one step instead.
 */
function advanceCalendarDays(from: Date, days: number, now: number): Date | null {
  if (!Number.isSafeInteger(days) || days <= 0) return null;
  let next = addCalendarDays(from, days);
  if (!Number.isFinite(next.getTime())) return null;
  let guard = 0;
  while (next.getTime() <= now && guard < MAX_CATCHUP_STEPS) {
    next = addCalendarDays(next, days);
    guard += 1;
  }
  if (next.getTime() <= now) {
    // More than MAX_CATCHUP_STEPS periods late (a long outage, or a database
    // restored from an old backup). Compare whole UTC calendar days so the
    // result does not depend on the local offset.
    const nowDate = new Date(now);
    const fromDay = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
    const nowDay = Date.UTC(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
    const periods = Math.max(1, Math.floor((nowDay - fromDay) / 86_400_000 / days) + 1);
    next = addCalendarDays(from, periods * days);
  }
  // An out-of-range `days` makes `addCalendarDays` produce an Invalid Date.
  // Returning it would be truthy, so `processReminders` (which only checks for
  // null) would write NaN into remind_at and retry the send as a failure.
  return Number.isFinite(next.getTime()) ? next : null;
}

function addCalendarDays(from: Date, days: number): Date {
  return dateFromComponents(from, { date: from.getDate() + days });
}

export function computeNextOccurrence(
  lastFire: Date,
  recurrence: string,
  anchorDay: number = lastFire.getDate(),
  /** Injectable clock; defaults to now. Tests pass a fixed instant so a DST
   *  boundary can be crossed deterministically. */
  now: number = Date.now(),
): Date | null {
  const lower = recurrence.toLowerCase().trim();

  if (lower === 'monthly') {
    return nextMonthly(lastFire, anchorDay, now);
  }

  // Calendar cadences keep their local wall-clock time across DST, and never
  // return a date that is still in the past.
  if (lower === 'daily') return advanceCalendarDays(lastFire, 1, now);
  if (lower === 'weekly') return advanceCalendarDays(lastFire, 7, now);

  let intervalMs: number;
  if (lower === 'hourly') intervalMs = 3_600_000;
  else {
    const match = lower.match(/^every\s+(\d+(?:\.\d+)?)\s*(m|min|minutes?|h|hours?|d|days?)$/);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = match[2]![0];
    // A whole number of days is a calendar cadence: `every 1 day` at 09:00 must
    // still fire at 09:00 after a DST change, exactly like `daily`. A fractional
    // day has no calendar meaning, so it keeps the fixed-millisecond behaviour.
    intervalMs = amount * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
    // Validate before the day special-case, or a whole number of days skips the
    // bound check entirely and an absurd interval (or an Invalid Date) passes
    // `isValidRecurrence`.
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) return null;
    if (unit === 'd' && Number.isInteger(amount)) return advanceCalendarDays(lastFire, amount, now);
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

function logReminderProcessingError(error: unknown): void {
  logger.error({ err: error }, 'Reminder processing failed');
}

export class Scheduler {
  private static senders = new Map<string, SendFn>();
  private static taskRunner: ScheduledTaskFn | null = null;
  private static timer: ReturnType<typeof setInterval> | null = null;
  private static processing = false;
  private static stopped = false;

  static registerSender(platform: string, fn: SendFn): void {
    this.senders.set(platform, fn);
  }

  static unregisterSender(platform: string): void {
    this.senders.delete(platform);
  }

  /**
   * Register the handler for reminders whose message is an agent instruction
   * (see `AGENT_TASK_PREFIX`). Without one, such a reminder is delivered as
   * literal text so a misconfiguration degrades instead of losing the message.
   *
   * `null` clears the runner. The scheduler is a process-global singleton, so a
   * stop/start cycle in one process must be able to remove the previous owner.
   */
  static registerTaskRunner(fn: ScheduledTaskFn | null): void {
    this.taskRunner = fn;
  }

  /**
   * Drop the in-memory delivery-retry counter for a reminder that no longer
   * exists. `processReminders` only clears entries on success or retirement, so
   * a reminder that failed at least once and was then cancelled by the user left
   * its counter behind for the lifetime of the process.
   */
  static forgetReminder(id: number): void {
    clearAttempts(id);
  }

  /**
   * Bound for a single scheduled agent run.
   *
   * `SCHEDULED_TASKS_TIMEOUT_MS` is a documented, validated operator setting,
   * so it has to be the thing that actually applies. A hard-coded constant meant
   * the env var was parsed, asserted in a unit test and then ignored: an
   * operator who raised it to allow a long analysis silently got a two-minute
   * abort, and one who lowered it got none of the protection.
   */
  static taskTimeoutMs(): number {
    return readIntegerEnv(process.env.SCHEDULED_TASKS_TIMEOUT_MS, TASK_TIMEOUT_MS, { min: 5_000, max: 900_000 });
  }

  /**
   * How long a claim must sit idle before another tick may take it over.
   *
   * The floor is {@link STALE_CLAIM_MS}, but it must never be shorter than the
   * longest a single delivery can run: a scheduled agent task may legitimately
   * run for up to `SCHEDULED_TASKS_TIMEOUT_MS`. Reclaiming a claim while its
   * original worker is still running delivered the same reminder twice (a second
   * send, and a second full agent run with tool side effects), contradicting the
   * at-most-once semantics documented on `reminders.claimed_at`.
   */
  private static staleClaimMs(): number {
    return Math.max(STALE_CLAIM_MS, this.taskTimeoutMs());
  }

  static start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.processReminders().catch(logReminderProcessingError);
    this.timer = setInterval(() => {
      void this.processReminders().catch(logReminderProcessingError);
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
      const staleClaimCutoff = new Date(now.getTime() - this.staleClaimMs());
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
            // No sender is registered for this platform. That is a configuration
            // problem, not a transient send failure: releasing the claim with
            // `remindAt = now` made the row immediately due again, so it was
            // retried every tick for the life of the process. Route it through the
            // normal backoff so it retries with growing delays and is retired
            // after MAX_DELIVERY_ATTEMPTS.
            this.deferOrRetire(reminder, `No sender registered for platform "${reminder.platform}"`);
            continue;
          }

          const target = resolveReminderTarget(reminder);
          if (target.mismatch) {
            // A room_key/chat_room_id disagreement is permanent data corruption:
            // no amount of retrying can resolve it, so retire on first sight
            // rather than logging the same error every 30s forever.
            this.retireClaim(reminder.id);
            logger.error({ id: reminder.id, roomKey: target.roomKey, reason: target.mismatch }, 'Reminder delivery refused; reminder retired');
            continue;
          }

          const instruction = parseAgentTaskMessage(reminder.message);
          if (instruction !== null && this.taskRunner) {
            // An agent task: run the model in the room instead of sending the
            // literal reminder text. The runner applies the scheduled-task policy
            // and budget before spending anything.
            await withCancellableTimeout(
              signal => this.taskRunner!({
                platform: reminder.platform,
                remoteRoomId: target.remoteRoomId,
                roomKey: target.roomKey,
                language: target.language ?? 'en',
                instruction,
                signal,
              }),
              this.taskTimeoutMs(),
              'scheduled agent task',
            );
          } else {
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
          }

          // Bookkeeping runs in its own try: a failed state write *after* a
          // successful send is not a delivery failure. Letting it reach the outer
          // catch re-armed the reminder and delivered the same message twice.
          try {
            if (reminder.recurrence) {
              // Anchor the monthly cadence to the day the user actually chose.
              // `anchor_day` is written when the reminder is created; it cannot be
              // derived later, because `remind_at` holds the *clamped* date of the
              // previous fire (Jan 31 -> Feb 28) and `created_at` is unrelated to
              // the fire date (a reminder set on the 28th for Dec 1 drifted to the
              // 28th of every month). Rows created before the column existed fall
              // back to the previous behaviour.
              const anchorDay = reminder.anchorDay
                ?? reminder.created_at?.getDate()
                ?? reminder.remindAt.getDate();
              const nextFire = computeNextOccurrence(reminder.remindAt, reminder.recurrence, anchorDay);
              if (!nextFire) {
                db.update(reminders)
                  .set({ isSent: true, claimedAt: null })
                  .where(eq(reminders.id, reminder.id))
                  .run();
                logger.error({ id: reminder.id, recurrence: reminder.recurrence }, 'Invalid recurrence; reminder retired');
                clearAttempts(reminder.id);
                continue;
              }
              db.update(reminders)
                .set({ remindAt: nextFire, claimedAt: null })
                .where(eq(reminders.id, reminder.id))
                .run();
              clearAttempts(reminder.id);
            } else {
              db.update(reminders)
                .set({ isSent: true, claimedAt: null })
                .where(eq(reminders.id, reminder.id))
                .run();
              clearAttempts(reminder.id);
            }
          } catch (stateError: unknown) {
            logger.error(
              { err: stateError, id: reminder.id },
              'Reminder was delivered but its delivery state could not be recorded',
            );
          }
        } catch (err) {
          const attempt = (retryAttempts.get(reminder.id) ?? 0) + 1;
          retryAttempts.set(reminder.id, attempt);
          const backoffMs = exponentialBackoff(attempt, { baseMs: 30_000, maxExponent: 7 });
          // A recurring reminder that keeps failing must not be retried on
          // every 30 s tick forever. The backoff was computed and then thrown
          // away: `preserveSchedule` left `claimedAt` null, so the row was
          // immediately due again and the retry storm ran for the lifetime of
          // the process — one provider send per recurring reminder per tick,
          // for every broken reminder, with no attempt limit.
          //
          // The claim is now held until the backoff expires, which paces the
          // retries, and a reminder that has exhausted its attempts is
          // retired instead of retried forever.
          if (attempt >= MAX_DELIVERY_ATTEMPTS) {
            this.retireClaim(reminder.id);
            logger.error({ err, id: reminder.id, attempt }, 'Reminder delivery failed permanently; retiring');
            continue;
          }
          this.releaseClaim(reminder.id, new Date(Date.now() + backoffMs), {
            // `remindAt` is the recurrence anchor, so overwriting it with a retry
            // time permanently re-based the schedule: one transient send error on
            // a 09:00 daily reminder moved it to 15:00 forever, because the next
            // successful fire computed from the retry time. Retry pacing now lives
            // in `claimedAt` (an in-memory attempt counter plus a non-null claim
            // already gates reselection) and the anchor is left alone.
            //
            // One exception: a one-shot reminder has no anchor to protect, and
            // leaving `remindAt` in the past would make it immediately due again
            // and burn a provider send per tick.
            preserveSchedule: Boolean(reminder.recurrence),
          });
          logger.error({ err, id: reminder.id, attempt }, 'Reminder delivery failed');
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private static releaseClaim(id: number, nextAttempt: Date, options: { preserveSchedule?: boolean } = {}): void {
    db.update(reminders)
      .set(options.preserveSchedule
        ? // Keep `remindAt` as the recurrence anchor, but hold the claim until
          // the backoff expires. The claim is what gates reselection, so
          // setting it to the next attempt time is what actually paces the
          // retries; leaving it null made every failed recurring reminder
          // immediately due again.
          { claimedAt: nextAttempt }
        : { claimedAt: null, remindAt: nextAttempt })
      .where(and(eq(reminders.id, id), eq(reminders.isSent, false)))
      .run();
  }

  /**
   * Permanently retire a reminder that can never be delivered, so it stops being
   * selected and stops occupying the in-memory retry map.
   */
  private static retireClaim(id: number): void {
    clearAttempts(id);
    db.update(reminders)
      // `recurrence` is cleared as well: a retired recurring reminder is a
      // terminal one-shot, and retention only prunes `is_sent = 1 AND
      // recurrence IS NULL`, so leaving it set made the row immortal.
      .set({ isSent: true, claimedAt: null, recurrence: null })
      .where(and(eq(reminders.id, id), eq(reminders.isSent, false)))
      .run();
  }

  /**
   * Back off a delivery that could not be attempted at all (no sender registered
   * for the platform). This is what keeps an undeliverable reminder from being
   * reselected on every single scheduler tick.
   *
   * Differences from the send-failure path, all deliberate:
   *  - a recurring reminder keeps its `remindAt` anchor (`preserveSchedule`), so
   *    a temporary outage does not permanently re-base a daily/weekly cadence;
   *  - attempts are tracked in their own counter ({@link deferAttempts}), so a
   *    long outage cannot consume the send-failure budget and make the first
   *    real error after recovery retire the reminder;
   *  - the cap is much larger, because "no sender registered" is a configuration
   *    state that can persist for hours (a provider in degraded mode), not a
   *    poison payload. Retiring a user's reminder after ~8 minutes of a platform
   *    being down silently destroyed it;
   *  - a *recurring* reminder is never retired here. The next occurrence is the
   *    natural retry, so a long outage merely skips periods instead of deleting
   *    the reminder for good.
   */
  private static deferOrRetire(reminder: { id: number; recurrence: string | null }, reason: string): void {
    const id = reminder.id;
    const attempt = (deferAttempts.get(id) ?? 0) + 1;
    if (attempt >= MAX_DEFER_ATTEMPTS && !reminder.recurrence) {
      this.retireClaim(id);
      logger.error({ id, reason, attempt }, 'Reminder undeliverable after repeated attempts; retired');
      return;
    }
    deferAttempts.set(id, attempt);
    const backoffMs = exponentialBackoff(attempt, { baseMs: 30_000, maxExponent: 7 });
    this.releaseClaim(id, new Date(Date.now() + backoffMs), { preserveSchedule: Boolean(reminder.recurrence) });
    logger.warn({ id, reason, attempt, retryInMs: backoffMs }, 'Reminder delivery deferred');
  }
}
