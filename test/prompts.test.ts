import { describe, test, expect } from 'bun:test';
import { getDefaultSystemPrompt } from '../src/core/prompts';

describe('getDefaultSystemPrompt', () => {
  test('returns a non-empty string', () => {
    const prompt = getDefaultSystemPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  test('contains {{LANGUAGE}} placeholder', () => {
    const prompt = getDefaultSystemPrompt();
    expect(prompt).toContain('{{LANGUAGE}}');
  });

  test('introduces the bot as ElastraX', () => {
    const prompt = getDefaultSystemPrompt();
    expect(prompt).toContain('ElastraX');
  });
});
