/**
 * test/configRuntime.test.ts
 *
 * The `read*Env` helpers back values that are evaluated per LLM call and per
 * message, so their handling of an empty value (and how often they warn) matters:
 * a container that passes `KEY=` for an optional setting used to log a warning on
 * every single message.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { logger } from '../src/utils/logger';
import { readBooleanEnv, readFloatEnv, readIntegerEnv } from '../src/config/runtime';

describe('readIntegerEnv', () => {
  test('treats an undefined or empty value as unset and returns the fallback', () => {
    expect(readIntegerEnv(undefined, 45000)).toBe(45000);
    expect(readIntegerEnv('', 45000)).toBe(45000);
    expect(readIntegerEnv('   ', 45000)).toBe(45000);
  });

  test('parses a value inside its bounds', () => {
    expect(readIntegerEnv('2048', 1, { min: 1, max: 8192 })).toBe(2048);
    expect(readIntegerEnv('  -5 ', 1)).toBe(-5);
  });

  test('falls back for a malformed or out-of-range value', () => {
    expect(readIntegerEnv('abc', 7)).toBe(7);
    expect(readIntegerEnv('1e5', 7)).toBe(7);
    expect(readIntegerEnv('0', 7, { min: 1 })).toBe(7);
    expect(readIntegerEnv('99999', 7, { max: 100 })).toBe(7);
  });

  describe('warning volume', () => {
    const originalWarn = logger.warn;
    let warn: ReturnType<typeof mock>;
    const originalNodeEnv = process.env.NODE_ENV;

    beforeEach(() => {
      warn = mock(() => {});
      logger.warn = warn as unknown as typeof logger.warn;
      // `warnOnce` is silent under NODE_ENV=test, so observe the production path.
      process.env.NODE_ENV = 'production';
    });

    afterEach(() => {
      logger.warn = originalWarn;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    });

    test('does not warn for an empty value', () => {
      readIntegerEnv('', 45000);
      readFloatEnv('', 0.5);
      expect(warn).toHaveBeenCalledTimes(0);
    });

    test('warns once per distinct message, not once per call', () => {
      for (let index = 0; index < 5; index += 1) readIntegerEnv('not-a-number', 42);
      const invalidIntegerWarnings = warn.mock.calls
        .map(call => String(call[0]))
        .filter(message => message.includes('Invalid integer "not-a-number"'));
      expect(invalidIntegerWarnings).toHaveLength(1);
    });
  });
});

describe('readFloatEnv', () => {
  test('accepts a decimal and treats empty as unset', () => {
    expect(readFloatEnv('0.7', 0.5)).toBe(0.7);
    expect(readFloatEnv('', 0.5)).toBe(0.5);
    expect(readFloatEnv('nope', 0.5)).toBe(0.5);
    expect(readFloatEnv('-1', 0.5, { min: 0 })).toBe(0.5);
  });
});

describe('readBooleanEnv', () => {
  test('accepts true/false and falls back otherwise', () => {
    expect(readBooleanEnv('true', false)).toBe(true);
    expect(readBooleanEnv(' FALSE ', true)).toBe(false);
    expect(readBooleanEnv('', true)).toBe(true);
    expect(readBooleanEnv(undefined, false)).toBe(false);
    expect(readBooleanEnv('yes', true)).toBe(true);
  });
});
