import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { ModelRouter, getModelRouter } from '../src/utils/ModelRouter';

describe('ModelRouter', () => {
  const savedBaseUrl = process.env.AI_API_BASE_URL;

  beforeEach(() => {
    // Ensure env var is set for router construction
    if (!process.env.AI_API_BASE_URL) {
      process.env.AI_API_BASE_URL = 'https://test-api.example.com/v1';
    }
  });

  afterEach(() => {
    if (savedBaseUrl) {
      process.env.AI_API_BASE_URL = savedBaseUrl;
    }
  });

  test('constructor does not throw when AI_API_BASE_URL is set', () => {
    expect(() => new ModelRouter()).not.toThrow();
  });

  test('chatCompletion returns a response', async () => {
    const router = new ModelRouter();
    const internalProviders = (router as any).providers;
    const clientSpy = spyOn(internalProviders[0].client, 'chatCompletion')
      .mockResolvedValue({ role: 'assistant', content: 'Hello' });

    const result = await router.chatCompletion([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('Hello');
    clientSpy.mockRestore();
  });

  test('chatCompletion with empty content triggers failover and throws with single provider', async () => {
    const router = new ModelRouter();
    const internalProviders = (router as any).providers;
    const clientSpy = spyOn(internalProviders[0].client, 'chatCompletion')
      .mockResolvedValue({ role: 'assistant', content: '' });

    await expect(router.chatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow();
    clientSpy.mockRestore();
  });

  test('getModelRouter returns a ModelRouter instance', () => {
    const router = getModelRouter();
    expect(router).toBeInstanceOf(ModelRouter);
  });

  test('getProviders returns array of provider configs', () => {
    const router = new ModelRouter();
    const providers = router.getProviders();
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    expect(providers[0].name).toBeDefined();
  });
});
