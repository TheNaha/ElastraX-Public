/**
 * Tests for scheduled agent runs.
 *
 * The guardrails are the point of this feature: a run has nobody watching, so
 * the tests assert that a task is refused unless it is enabled, the room is
 * allowlisted, and the budget has room — and that a denial happens *before* any
 * model call rather than after.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  readScheduledTaskPolicy,
  isAgentTaskMessage,
  parseAgentTaskMessage,
  createTaskBudget,
  consumeTaskBudget,
  describePolicy,
  AGENT_TASK_PREFIX,
  type ScheduledTaskPolicy,
} from '../src/utils/scheduledTasks';

const ROOM = 'room:whatsapp:1234567890@g.us';
const OTHER_ROOM = 'room:whatsapp:999@g.us';

function policy(overrides: Partial<ScheduledTaskPolicy> = {}): ScheduledTaskPolicy {
  return {
    enabled: true,
    allowedRooms: [ROOM],
    maxRunsPerDay: 3,
    maxRunsPerRoomPerDay: 2,
    timeoutMs: 60_000,
    deniedTools: ['owner_admin', 'role', 'config', 'groupadmin'],
    ...overrides,
  };
}

describe('scheduled task policy parsing', () => {
  test('is disabled by default', () => {
    const config = readScheduledTaskPolicy({} as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
    expect(config.allowedRooms).toEqual([]);
  });

  test('enables only on an explicit truthy value', () => {
    for (const value of ['1', 'true', 'YES', 'on']) {
      expect(readScheduledTaskPolicy({ SCHEDULED_TASKS_ENABLED: value } as NodeJS.ProcessEnv).enabled).toBe(true);
    }
    for (const value of ['0', 'false', 'no', '', 'maybe']) {
      expect(readScheduledTaskPolicy({ SCHEDULED_TASKS_ENABLED: value } as NodeJS.ProcessEnv).enabled).toBe(false);
    }
  });

  test('parses and trims the room allowlist', () => {
    const config = readScheduledTaskPolicy({
      SCHEDULED_TASKS_ENABLED: 'true',
      SCHEDULED_TASKS_ALLOWED_ROOMS: ` ${ROOM} , ${OTHER_ROOM} ,`,
    } as NodeJS.ProcessEnv);
    expect(config.allowedRooms).toEqual([ROOM, OTHER_ROOM]);
  });

  test('denies destructive tools by default', () => {
    // A run with nobody present must not be able to change bot-wide state.
    const config = readScheduledTaskPolicy({ SCHEDULED_TASKS_ENABLED: 'true' } as NodeJS.ProcessEnv);
    for (const tool of ['owner_admin', 'role', 'config', 'reload_plugins', 'groupadmin']) {
      expect(config.deniedTools).toContain(tool);
    }
  });

  test('rejects out-of-range budgets rather than adopting them', () => {
    // readIntegerEnv returns the fallback for an out-of-range value, so a hostile
    // or typo'd setting never becomes a hostile or typo'd budget.
    const config = readScheduledTaskPolicy({
      SCHEDULED_TASKS_MAX_RUNS_PER_DAY: '999999',
      SCHEDULED_TASKS_TIMEOUT_MS: '1',
    } as NodeJS.ProcessEnv);
    expect(config.maxRunsPerDay).toBe(20);
    expect(config.timeoutMs).toBe(120_000);
    const inRange = readScheduledTaskPolicy({
      SCHEDULED_TASKS_MAX_RUNS_PER_DAY: '5',
      SCHEDULED_TASKS_TIMEOUT_MS: '30000',
    } as NodeJS.ProcessEnv);
    expect(inRange.maxRunsPerDay).toBe(5);
    expect(inRange.timeoutMs).toBe(30_000);
  });
});

describe('agent task message detection', () => {
  test('recognises the marker only with a trailing instruction', () => {
    expect(isAgentTaskMessage('/task summarise this')).toBe(true);
    expect(isAgentTaskMessage('  /TASK summarise this')).toBe(true);
    // No space means no instruction, so it is an ordinary reminder.
    expect(isAgentTaskMessage('/task')).toBe(false);
    expect(isAgentTaskMessage('/task   ')).toBe(false);
    expect(isAgentTaskMessage('remind me about /task runs')).toBe(false);
  });

  test('strips the marker and trims', () => {
    expect(parseAgentTaskMessage('/task  summarise the day ')).toBe('summarise the day');
    expect(parseAgentTaskMessage(`  ${AGENT_TASK_PREFIX} do a thing`)).toBe('do a thing');
  });

  test('returns null for an ordinary reminder', () => {
    expect(parseAgentTaskMessage('standup in 5 minutes')).toBeNull();
    expect(parseAgentTaskMessage('/task')).toBeNull();
  });

  test('leaves an ordinary reminder untouched', () => {
    expect(parseAgentTaskMessage('buy milk')).toBeNull();
    expect(isAgentTaskMessage('buy milk')).toBe(false);
  });
});

describe('scheduled task budget', () => {
  let budget: ReturnType<typeof createTaskBudget>;

  beforeEach(() => {
    budget = createTaskBudget();
  });

  test('refuses when disabled', () => {
    const decision = consumeTaskBudget(budget, policy({ enabled: false }), ROOM);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('disabled');
  });

  test('refuses when no rooms are allowlisted', () => {
    // The important case: enabling the feature without naming rooms must not
    // mean "everybody".
    const decision = consumeTaskBudget(budget, policy({ allowedRooms: [] }), ROOM);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('no rooms');
  });

  test('refuses a room that is not allowlisted', () => {
    const decision = consumeTaskBudget(budget, policy(), OTHER_ROOM);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('not in');
  });

  test('allows an allowlisted room and counts the run', () => {
    expect(consumeTaskBudget(budget, policy(), ROOM).allowed).toBe(true);
    expect(consumeTaskBudget(budget, policy(), ROOM).allowed).toBe(true);
    // Per-room ceiling is 2.
    const third = consumeTaskBudget(budget, policy(), ROOM);
    expect(third.allowed).toBe(false);
    if (!third.allowed) expect(third.reason).toContain('room scheduled task limit');
  });

  test('enforces the daily ceiling across rooms', () => {
    const wide = policy({ maxRunsPerDay: 2, maxRunsPerRoomPerDay: 5, allowedRooms: [ROOM, OTHER_ROOM] });
    expect(consumeTaskBudget(budget, wide, ROOM).allowed).toBe(true);
    expect(consumeTaskBudget(budget, wide, OTHER_ROOM).allowed).toBe(true);
    const third = consumeTaskBudget(budget, wide, OTHER_ROOM);
    expect(third.allowed).toBe(false);
    if (!third.allowed) expect(third.reason).toContain('daily scheduled task limit');
  });

  test('a zero budget blocks everything', () => {
    const decision = consumeTaskBudget(budget, policy({ maxRunsPerDay: 0 }), ROOM);
    expect(decision.allowed).toBe(false);
  });

  test('the day bucket is discarded so the map cannot grow unbounded', () => {
    const one = new Date('2026-01-01T23:00:00Z');
    const two = new Date('2026-01-02T01:00:00Z');
    consumeTaskBudget(budget, policy(), ROOM, one);
    expect(budget.runsByDay.size).toBe(1);
    // A refusal on the new day still prunes the stale bucket.
    consumeTaskBudget(budget, policy({ allowedRooms: [] }), ROOM, two);
    expect(budget.runsByDay.size).toBeLessThanOrEqual(1);
    for (const key of budget.runsByDay.keys()) expect(key).not.toBe('2026-01-01');
  });

  test('a refused run does not consume budget', () => {
    consumeTaskBudget(budget, policy(), OTHER_ROOM);
    consumeTaskBudget(budget, policy(), OTHER_ROOM);
    // ROOM still has its full allowance.
    expect(consumeTaskBudget(budget, policy(), ROOM).allowed).toBe(true);
    expect(consumeTaskBudget(budget, policy(), ROOM).allowed).toBe(true);
  });
});

describe('describePolicy', () => {
  test('explains a disabled configuration', () => {
    expect(describePolicy(policy({ enabled: false }))).toContain('disabled');
    expect(describePolicy(policy({ allowedRooms: [] }))).toContain('no rooms');
  });

  test('summarises an enabled configuration', () => {
    const summary = describePolicy(policy({ allowedRooms: [ROOM, OTHER_ROOM] }));
    expect(summary).toContain('2 room(s)');
    expect(summary).toContain('max 3/day');
  });
});
