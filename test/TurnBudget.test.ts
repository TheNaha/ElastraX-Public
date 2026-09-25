import { describe, expect, test } from 'bun:test';
import {
  HARD_TURN_BUDGET_LIMITS,
  TurnBudgetExceededError,
  createTurnBudget,
} from '../src/ai/turnBudget';

describe('TurnBudget', () => {
  test('exposes finite default caps', () => {
    const budget = createTurnBudget();
    expect(budget.limits).toEqual(HARD_TURN_BUDGET_LIMITS);
    expect(budget.limits.maxToolCalls).toBe(8);
    expect(budget.limits.maxParallelToolCalls).toBe(4);
    expect(Number.isFinite(budget.limits.maxToolResultBytes)).toBe(true);
    expect(Number.isFinite(budget.limits.maxTotalToolResultBytes)).toBe(true);
  });

  test('rejects excess tool calls before starting any task', async () => {
    const budget = createTurnBudget();
    let started = 0;
    const tasks = Array.from({ length: 9 }, () => async () => {
      started++;
      return 'ok';
    });

    await expect(budget.runToolCalls(tasks)).rejects.toBeInstanceOf(TurnBudgetExceededError);
    expect(started).toBe(0);
    expect(budget.snapshot().toolCalls).toBe(0);
  });

  test('runs at most four tool calls concurrently', async () => {
    const budget = createTurnBudget();
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 8 }, () => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return 'ok';
    });

    await budget.runToolCalls(tasks);
    expect(peak).toBe(4);
    expect(budget.snapshot().toolCalls).toBe(8);
  });

  test('enforces per-result and total byte caps', () => {
    const perResult = createTurnBudget({
      maxToolResultBytes: 4,
      maxTotalToolResultBytes: 6,
    });
    expect(() => perResult.recordToolResult('12345')).toThrow(TurnBudgetExceededError);
    expect(perResult.recordToolResult('1234')).toBe(4);
    expect(() => perResult.recordToolResult('12345')).toThrow(TurnBudgetExceededError);
    expect(perResult.recordToolResult('12')).toBe(2);
    expect(() => perResult.recordToolResult('1')).toThrow(TurnBudgetExceededError);
  });

  test('truncates text on a UTF-8 byte boundary', () => {
    const budget = createTurnBudget({
      maxToolResultBytes: 5,
      maxTotalToolResultBytes: 5,
    });
    const constrained = budget.constrainTextResult('aa😀b');
    expect(constrained.truncated).toBe(true);
    expect(Buffer.byteLength(constrained.value, 'utf8')).toBeLessThanOrEqual(5);
    expect(constrained.value.startsWith('aa')).toBe(true);
  });
});
