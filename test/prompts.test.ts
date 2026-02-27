import { describe, test, expect } from 'bun:test';
import { DEFAULT_SYSTEM_PROMPT } from '../src/core/prompts';

describe('DEFAULT_SYSTEM_PROMPT', () => {
  test('is a non-empty string', () => {
    expect(typeof DEFAULT_SYSTEM_PROMPT).toBe('string');
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  test('contains {{LANGUAGE}} placeholder', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('{{LANGUAGE}}');
  });

  test('introduces the bot as ElastraX', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('ElastraX');
  });
});
