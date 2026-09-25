export interface TurnBudgetLimits {
  maxToolCalls: number;
  maxParallelToolCalls: number;
  maxToolResultBytes: number;
  maxTotalToolResultBytes: number;
}

export interface TurnBudgetSnapshot {
  limits: Readonly<TurnBudgetLimits>;
  toolCalls: number;
  parallelToolCalls: number;
  toolResultBytes: number;
  totalToolResultBytes: number;
  remainingToolCalls: number;
}

export type TurnBudgetLimitName = keyof TurnBudgetLimits;

export class TurnBudgetExceededError extends Error {
  readonly code = 'turn_budget_exceeded';
  readonly limit: TurnBudgetLimitName;

  constructor(limit: TurnBudgetLimitName, message: string) {
    super(message);
    this.name = 'TurnBudgetExceededError';
    this.limit = limit;
  }
}

export const HARD_TURN_BUDGET_LIMITS: Readonly<TurnBudgetLimits> = Object.freeze({
  maxToolCalls: 8,
  maxParallelToolCalls: 4,
  maxToolResultBytes: 1024 * 1024,
  maxTotalToolResultBytes: 4 * 1024 * 1024,
});

const ABSOLUTE_LIMITS: Readonly<TurnBudgetLimits> = Object.freeze({
  maxToolCalls: 8,
  maxParallelToolCalls: 4,
  maxToolResultBytes: 10 * 1024 * 1024,
  maxTotalToolResultBytes: 40 * 1024 * 1024,
});

function normalizeLimit(name: keyof TurnBudgetLimits, value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return HARD_TURN_BUDGET_LIMITS[name];
  return Math.max(1, Math.min(Math.floor(value), ABSOLUTE_LIMITS[name]));
}

export function estimateToolResultBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (value instanceof Uint8Array) return value.byteLength;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export class TurnBudget {
  readonly limits: Readonly<TurnBudgetLimits>;
  private toolCalls = 0;
  private parallelToolCalls = 0;
  private toolResultBytes = 0;
  private totalToolResultBytes = 0;

  constructor(limits: Partial<TurnBudgetLimits> = {}) {
    this.limits = Object.freeze({
      maxToolCalls: normalizeLimit('maxToolCalls', limits.maxToolCalls),
      maxParallelToolCalls: normalizeLimit(
        'maxParallelToolCalls',
        limits.maxParallelToolCalls ?? limits.maxToolCalls,
      ),
      maxToolResultBytes: normalizeLimit('maxToolResultBytes', limits.maxToolResultBytes),
      maxTotalToolResultBytes: normalizeLimit(
        'maxTotalToolResultBytes',
        limits.maxTotalToolResultBytes ?? limits.maxToolResultBytes,
      ),
    });
  }

  claimToolCalls(count = 1): void {
    if (!Number.isInteger(count) || count < 1) {
      throw new TypeError('Tool-call count must be a positive integer.');
    }
    if (this.toolCalls + count > this.limits.maxToolCalls) {
      throw new TurnBudgetExceededError(
        'maxToolCalls',
        `Tool-call limit exceeded (${this.limits.maxToolCalls}).`,
      );
    }
    this.toolCalls += count;
  }

  beginParallelCall(): void {
    if (this.parallelToolCalls >= this.limits.maxParallelToolCalls) {
      throw new TurnBudgetExceededError(
        'maxParallelToolCalls',
        `Parallel tool-call limit exceeded (${this.limits.maxParallelToolCalls}).`,
      );
    }
    this.parallelToolCalls++;
  }

  endParallelCall(): void {
    this.parallelToolCalls = Math.max(0, this.parallelToolCalls - 1);
  }

  recordToolResult(value: unknown, byteLength = estimateToolResultBytes(value)): number {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new TypeError('Tool-result byte length must be a non-negative safe integer.');
    }
    if (byteLength > this.limits.maxToolResultBytes) {
      throw new TurnBudgetExceededError(
        'maxToolResultBytes',
        `Tool result exceeded ${this.limits.maxToolResultBytes} bytes.`,
      );
    }
    if (this.totalToolResultBytes + byteLength > this.limits.maxTotalToolResultBytes) {
      throw new TurnBudgetExceededError(
        'maxTotalToolResultBytes',
        `Total tool-result bytes exceeded ${this.limits.maxTotalToolResultBytes}.`,
      );
    }
    this.toolResultBytes = byteLength;
    this.totalToolResultBytes += byteLength;
    return byteLength;
  }

  constrainTextResult(value: string): { value: string; bytes: number; truncated: boolean } {
    const encoded = Buffer.from(value, 'utf8');
    const remainingTotal = this.limits.maxTotalToolResultBytes - this.totalToolResultBytes;
    const allowed = Math.min(this.limits.maxToolResultBytes, remainingTotal);
    if (allowed <= 0) {
      throw new TurnBudgetExceededError(
        'maxTotalToolResultBytes',
        `Total tool-result bytes exceeded ${this.limits.maxTotalToolResultBytes}.`,
      );
    }
    if (encoded.byteLength <= allowed) {
      const bytes = this.recordToolResult(value, encoded.byteLength);
      return { value, bytes, truncated: false };
    }
    let truncated = encoded.subarray(0, allowed).toString('utf8').replace(/\uFFFD$/, '');
    while (Buffer.byteLength(truncated, 'utf8') > allowed && truncated.length > 0) {
      truncated = truncated.slice(0, -1);
    }
    const bytes = this.recordToolResult(truncated, Buffer.byteLength(truncated, 'utf8'));
    return { value: truncated, bytes, truncated: true };
  }

  async runToolCalls<T>(
    tasks: ReadonlyArray<() => Promise<T>>,
    options: { byteLength?: (value: T) => number } = {},
  ): Promise<T[]> {
    if (tasks.length === 0) return [];
    this.claimToolCalls(tasks.length);
    const results = new Array<T>(tasks.length);
    let nextIndex = 0;
    let firstError: unknown;

    const worker = async (): Promise<void> => {
      while (firstError === undefined) {
        const index = nextIndex++;
        if (index >= tasks.length) return;
        this.beginParallelCall();
        try {
          const result = await tasks[index]!();
          this.recordToolResult(result, options.byteLength?.(result) ?? estimateToolResultBytes(result));
          results[index] = result;
        } catch (error: unknown) {
          if (firstError === undefined) firstError = error;
        } finally {
          this.endParallelCall();
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(this.limits.maxParallelToolCalls, tasks.length) },
      () => worker(),
    );
    await Promise.all(workers);
    if (firstError !== undefined) throw firstError;
    return results;
  }

  snapshot(): TurnBudgetSnapshot {
    return {
      limits: { ...this.limits },
      toolCalls: this.toolCalls,
      parallelToolCalls: this.parallelToolCalls,
      toolResultBytes: this.toolResultBytes,
      totalToolResultBytes: this.totalToolResultBytes,
      remainingToolCalls: this.limits.maxToolCalls - this.toolCalls,
    };
  }
}

export function createTurnBudget(limits: Partial<TurnBudgetLimits> = {}): TurnBudget {
  return new TurnBudget(limits);
}
