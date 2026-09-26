/**
 * @file src/utils/scheduledTasks.ts
 * @description Policy and budget for scheduled agent runs.
 *
 * A scheduled task runs the agent with no human in the loop, so unlike an
 * ordinary message it can spend money and take actions nobody is watching. Every
 * guard here exists because of that:
 *
 *  - it is off unless explicitly enabled
 *  - only rooms an operator named may run tasks
 *  - a daily ceiling bounds the cost of a misconfigured recurrence
 *  - a task never receives mutating tools
 *
 * Without the allowlist a single `/task` in any group would let anyone schedule
 * unlimited unattended LLM spend.
 */
import { readIntegerEnv, readStringEnv } from '../config/runtime';
import { logger } from './logger';

const log = logger.child({ module: 'ScheduledTasks' });

/** Reserved prefix marking a reminder's message as an agent instruction. */
export const AGENT_TASK_PREFIX = '/task';

export type ScheduledTaskPolicy = {
  enabled: boolean;
  allowedRooms: string[];
  maxRunsPerDay: number;
  maxRunsPerRoomPerDay: number;
  timeoutMs: number;
  /** Tools a scheduled run is never allowed to use. */
  deniedTools: string[];
};

export function readScheduledTaskPolicy(env: NodeJS.ProcessEnv = process.env): ScheduledTaskPolicy {
  const allowedRooms = (env.SCHEDULED_TASKS_ALLOWED_ROOMS ?? '')
    .split(',')
    .map(room => room.trim())
    .filter(Boolean);
  return {
    enabled: /^(1|true|yes|on)$/i.test(readStringEnv(env.SCHEDULED_TASKS_ENABLED)),
    allowedRooms,
    maxRunsPerDay: readIntegerEnv(env.SCHEDULED_TASKS_MAX_RUNS_PER_DAY, 20, { min: 0, max: 10_000 }),
    maxRunsPerRoomPerDay: readIntegerEnv(env.SCHEDULED_TASKS_MAX_RUNS_PER_ROOM_PER_DAY, 4, { min: 0, max: 1_000 }),
    timeoutMs: readIntegerEnv(env.SCHEDULED_TASKS_TIMEOUT_MS, 120_000, { min: 5_000, max: 900_000 }),
    // A run with nobody watching must not be able to change bot-wide or
    // destructive state, so these are removed from the tool set outright.
    deniedTools: ['owner_admin', 'role', 'config', 'reload_plugins', 'groupadmin', 'knowledge', 'reminder'],
  };
}

export function isAgentTaskMessage(message: string): boolean {
  // Delegated so the two exported predicates cannot disagree. A bare marker with
  // no instruction is not a task: the scheduler falls back to sending the
  // reminder text literally, which is what the user actually wrote.
  return parseAgentTaskMessage(message) !== null;
}

/** The instruction with its marker removed. */
export function parseAgentTaskMessage(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed.toLowerCase().startsWith(AGENT_TASK_PREFIX)) return null;
  const instruction = trimmed.slice(AGENT_TASK_PREFIX.length).trim();
  return instruction.length > 0 ? instruction : null;
}

export type TaskBudget = {
  /** Runs recorded today, keyed by UTC day. */
  runsByDay: Map<string, { total: number; byRoom: Map<string, number> }>;
};

export function createTaskBudget(): TaskBudget {
  return { runsByDay: new Map() };
}

function todayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export type BudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Decide whether a run may proceed, recording it when allowed. A single day
 * bucket is retained, so the map cannot grow without bound.
 */
export function consumeTaskBudget(
  budget: TaskBudget,
  policy: ScheduledTaskPolicy,
  roomKey: string,
  now: Date = new Date(),
): BudgetDecision {
  const day = todayKey(now);
  // Prune first, unconditionally. A size guard here looked like an optimisation
  // but skipped the common case: with a single stale bucket, `size > 1` was false
  // and yesterday's entry survived forever. The map holds at most a day's worth.
  for (const key of [...budget.runsByDay.keys()]) {
    if (key !== day) budget.runsByDay.delete(key);
  }

  if (!policy.enabled) return { allowed: false, reason: 'scheduled tasks are disabled' };
  if (policy.allowedRooms.length === 0) {
    return { allowed: false, reason: 'no rooms are allowed to run scheduled tasks' };
  }
  if (!policy.allowedRooms.includes(roomKey)) {
    return { allowed: false, reason: `room ${roomKey} is not in SCHEDULED_TASKS_ALLOWED_ROOMS` };
  }
  if (policy.maxRunsPerDay <= 0) return { allowed: false, reason: 'scheduled task budget is disabled' };

  const current = budget.runsByDay.get(day) ?? { total: 0, byRoom: new Map<string, number>() };
  const roomRuns = current.byRoom.get(roomKey) ?? 0;
  if (current.total >= policy.maxRunsPerDay) {
    return { allowed: false, reason: `daily scheduled task limit reached (${policy.maxRunsPerDay})` };
  }
  if (roomRuns >= policy.maxRunsPerRoomPerDay) {
    return { allowed: false, reason: `room scheduled task limit reached (${policy.maxRunsPerRoomPerDay})` };
  }

  current.total += 1;
  current.byRoom.set(roomKey, roomRuns + 1);
  budget.runsByDay.set(day, current);
  return { allowed: true };
}

export function describePolicy(policy: ScheduledTaskPolicy): string {
  if (!policy.enabled) return 'scheduled tasks are disabled (set SCHEDULED_TASKS_ENABLED=true)';
  if (policy.allowedRooms.length === 0) {
    return 'no rooms are allowed to run scheduled tasks (set SCHEDULED_TASKS_ALLOWED_ROOMS)';
  }
  return `allowed in ${policy.allowedRooms.length} room(s), max ${policy.maxRunsPerDay}/day, ${policy.maxRunsPerRoomPerDay}/room/day`;
}

export function logRefusal(roomKey: string, reason: string): void {
  log.warn({ roomKey, reason }, 'Refused scheduled agent task');
}
