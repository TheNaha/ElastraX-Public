/**
 * test/config.llm.test.ts
 *
 * Tests for the shared LLM provider resolution module (src/config/llm.ts),
 * verifying parity between legacy and multi-provider configurations.
 */

import { resolveLLMProviders, resolveLLMTargets, buildCloudflareBaseUrl } from '../src/config/llm';
import { test, describe, expect, afterEach } from 'bun:test';

describe('config/llm', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('buildCloudflareBaseUrl', () => {
    test('builds correct URL from account ID', () => {
      const url = buildCloudflareBaseUrl('my-account-id');
      expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/my-account-id/ai/v1');
    });

    test('trims whitespace from account ID', () => {
      const url = buildCloudflareBaseUrl('  my-account-id  ');
      expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/my-account-id/ai/v1');
    });

    test('returns empty string for no/empty account ID', () => {
      expect(buildCloudflareBaseUrl(undefined)).toBe('');
      expect(buildCloudflareBaseUrl('')).toBe('');
      expect(buildCloudflareBaseUrl('   ')).toBe('');
    });
  });

  describe('resolveLLMTargets (HealthMonitor interface)', () => {
    test('returns empty array when no config', () => {
      delete process.env.AI_API_BASE_URL;
      delete process.env.AI_PROVIDERS;
      delete process.env.AI_CF_ACCOUNT_ID;
      expect(resolveLLMTargets()).toEqual([]);
    });

    test('resolves legacy single-provider config', () => {
      process.env.AI_API_BASE_URL = 'https://example.com/v1';
      process.env.AI_API_KEY = 'key123';
      delete process.env.AI_PROVIDERS;

      const targets = resolveLLMTargets();
      expect(targets).toEqual([
        { key: 'llm', baseUrl: 'https://example.com/v1', apiKey: 'key123' },
      ]);
    });

    test('resolves Cloudflare worker-style config', () => {
      delete process.env.AI_API_BASE_URL;
      delete process.env.AI_API_KEY;
      delete process.env.AI_PROVIDERS;
      process.env.AI_CF_ACCOUNT_ID = 'cf-account';
      process.env.AI_CF_API_TOKEN = 'cf-token';

      const targets = resolveLLMTargets();
      expect(targets[0].key).toBe('llm');
      expect(targets[0].baseUrl).toContain('api.cloudflare.com');
      expect(targets[0].baseUrl).toContain('cf-account');
      expect(targets[0].apiKey).toBe('cf-token');
    });
  });

  describe('resolveLLMProviders (full config)', () => {
    test('resolves legacy config with all fields', () => {
      process.env.AI_API_BASE_URL = 'https://example.com/v1';
      process.env.AI_API_KEY = 'key123';
      process.env.AI_MODEL_NAME = 'my-model';
      process.env.AI_TIER = 'fast';
      delete process.env.AI_PROVIDERS;

      const providers = resolveLLMProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].name).toBe('default');
      expect(providers[0].baseUrl).toBe('https://example.com/v1');
      expect(providers[0].apiKey).toBe('key123');
      expect(providers[0].modelName).toBe('my-model');
      expect(providers[0].tier).toBe('fast');
    });

    test('multi-provider config resolves per-provider env vars', () => {
      process.env.AI_PROVIDERS = 'modal,gemini';
      process.env.AI_MODAL_BASE_URL = 'https://modal.example.com/v1';
      process.env.AI_MODAL_API_KEY = 'modal-key';
      process.env.AI_MODAL_MODEL = 'Qwen3';
      process.env.AI_MODAL_TIER = 'powerful';
      process.env.AI_GEMINI_BASE_URL = 'https://gemini.example.com/v1';
      process.env.AI_GEMINI_API_KEY = 'gemini-key';

      const providers = resolveLLMProviders();
      expect(providers).toHaveLength(2);

      expect(providers[0].name).toBe('modal');
      expect(providers[0].baseUrl).toBe('https://modal.example.com/v1');
      expect(providers[0].modelName).toBe('Qwen3');
      expect(providers[0].tier).toBe('powerful');
      expect(providers[0].supportsVideo).toBe(true);
      expect(providers[0].supportsAudio).toBe(true);

      expect(providers[1].name).toBe('gemini');
      expect(providers[1].supportsVideo).toBe(false);
      expect(providers[1].supportsAudio).toBe(false);
    });

    test('filters providers with no baseUrl', () => {
      process.env.AI_PROVIDERS = 'modal,broken';
      process.env.AI_MODAL_BASE_URL = 'https://modal.example.com/v1';
      process.env.AI_MODAL_API_KEY = 'modal-key';
      // broken has no BASE_URL or CF_ACCOUNT_ID

      const providers = resolveLLMProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].name).toBe('modal');
    });

    test('modal provider defaults to multimodal support', () => {
      process.env.AI_PROVIDERS = 'modal';
      process.env.AI_MODAL_BASE_URL = 'https://modal.example.com/v1';
      process.env.AI_MODAL_API_KEY = 'key';

      const providers = resolveLLMProviders();
      expect(providers[0].name).toBe('modal');
      expect(providers[0].supportsVideo).toBe(true);
      expect(providers[0].supportsAudio).toBe(true);
    });

    test('non-multimodal providers default to no media support', () => {
      process.env.AI_PROVIDERS = 'gemini';
      process.env.AI_GEMINI_BASE_URL = 'https://gemini.example.com/v1';
      process.env.AI_GEMINI_API_KEY = 'key';

      const providers = resolveLLMProviders();
      expect(providers[0].supportsVideo).toBe(false);
      expect(providers[0].supportsAudio).toBe(false);
    });
  });
});
