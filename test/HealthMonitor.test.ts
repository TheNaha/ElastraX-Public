/**
 * test/HealthMonitor.test.ts
 *
 * Tests for the HealthMonitor lifecycle: start/stop, interval management,
 * and LLM target resolution via the shared config/llm.ts resolver.
 */

import { HealthMonitor, healthMonitor } from '../src/utils/HealthMonitor';
import { resolveLLMTargets, resolveLLMProviders } from '../src/config/llm';
import { describe, test, expect, afterEach } from 'bun:test';

describe('HealthMonitor', () => {
  describe('resolveLLMTargets', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    test('returns empty array when no AI config is set', () => {
      delete process.env.AI_API_BASE_URL;
      delete process.env.AI_PROVIDERS;
      delete process.env.AI_CF_ACCOUNT_ID;
      const targets = resolveLLMTargets();
      expect(targets).toEqual([]);
    });

    test('returns single target for legacy single-provider config', () => {
      process.env.AI_API_BASE_URL = 'https://api.example.com/v1';
      process.env.AI_API_KEY = 'test-key';
      delete process.env.AI_PROVIDERS;

      const targets = resolveLLMTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0].key).toBe('llm');
      expect(targets[0].baseUrl).toBe('https://api.example.com/v1');
      expect(targets[0].apiKey).toBe('test-key');
    });

    test('returns multiple targets for multi-provider config', () => {
      process.env.AI_PROVIDERS = 'modal,gemini';
      process.env.AI_MODAL_BASE_URL = 'https://modal.example.com/v1';
      process.env.AI_MODAL_API_KEY = 'modal-key';
      process.env.AI_GEMINI_BASE_URL = 'https://gemini.example.com/v1';
      process.env.AI_GEMINI_API_KEY = 'gemini-key';

      const targets = resolveLLMTargets();
      expect(targets).toHaveLength(2);
      expect(targets[0].key).toBe('llm:modal');
      expect(targets[1].key).toBe('llm:gemini');
    });

    test('filters out providers with no base URL', () => {
      process.env.AI_PROVIDERS = 'modal,broken';
      process.env.AI_MODAL_BASE_URL = 'https://modal.example.com/v1';
      process.env.AI_MODAL_API_KEY = 'modal-key';
      // 'broken' provider has no BASE_URL or CF_ACCOUNT_ID, should be filtered

      const targets = resolveLLMTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0].key).toBe('llm:modal');
    });
  });

  describe('resolveLLMProviders', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    test('includes model name, tier, and media support', () => {
      process.env.AI_MODAL_BASE_URL = 'https://modal.example.com/v1';
      process.env.AI_MODAL_API_KEY = 'modal-key';
      process.env.AI_MODAL_MODEL = 'Qwen3-Omni';
      process.env.AI_MODAL_TIER = 'fast';
      process.env.AI_MODAL_SUPPORTS_VIDEO = 'true';
      process.env.AI_PROVIDERS = 'modal';

      const providers = resolveLLMProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].modelName).toBe('Qwen3-Omni');
      expect(providers[0].tier).toBe('fast');
      expect(providers[0].supportsVideo).toBe(true);
      expect(providers[0].supportsAudio).toBe(true);
    });

    test('defaults to false for media support on non-multimodal providers', () => {
      process.env.AI_GEMINI_BASE_URL = 'https://gemini.example.com/v1';
      process.env.AI_GEMINI_API_KEY = 'gemini-key';
      process.env.AI_PROVIDERS = 'gemini';

      const providers = resolveLLMProviders();
      expect(providers[0].supportsVideo).toBe(false);
      expect(providers[0].supportsAudio).toBe(false);
    });
  });

  describe('HealthMonitor lifecycle', () => {
    test('start/stop manages timers correctly', () => {
      const monitor = new HealthMonitor();

      // Should not throw
      monitor.start();
      const timersBeforeStop = (monitor as any).timers.length;
      expect(timersBeforeStop).toBeGreaterThanOrEqual(0);

      monitor.stop();
      const timersAfterStop = (monitor as any).timers.length;
      expect(timersAfterStop).toBe(0);
    });

    test('singleton healthMonitor is exported', () => {
      expect(healthMonitor).toBeInstanceOf(HealthMonitor);
    });
  });
});
