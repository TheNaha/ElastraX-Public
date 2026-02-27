import { describe, test, expect, mock, beforeEach } from 'bun:test';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

mock.module('../src/utils/HealthMetrics', () => ({
  healthMetrics: { recordLLMRequest: mock(() => {}) },
}));

const mockChatCompletion = mock(async () => ({ role: 'assistant', content: 'Hello' }));
const mockChatCompletionStream = mock(async function*() { yield { choices: [{ delta: { content: 'Hi' } }] }; });

mock.module('../src/ai/client', () => ({
  AIClient: class {
    chatCompletion = mockChatCompletion;
    chatCompletionStream = mockChatCompletionStream;
  },
}));

import { ModelRouter, getModelRouter } from '../src/utils/ModelRouter';

describe('ModelRouter', () => {
  beforeEach(() => {
    mockChatCompletion.mockReset();
    mockChatCompletion.mockImplementation(async () => ({ role: 'assistant', content: 'Hello' }));
  });

  test('constructor does not throw when AI_API_BASE_URL is set', () => {
    expect(() => new ModelRouter()).not.toThrow();
  });

  test('chatCompletion returns a response', async () => {
    const router = new ModelRouter();
    const result = await router.chatCompletion([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('Hello');
  });

  test('chatCompletion with empty content triggers failover and throws with single provider', async () => {
    mockChatCompletion.mockImplementation(async () => ({ role: 'assistant', content: '' }));
    const router = new ModelRouter();
    await expect(router.chatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow();
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
