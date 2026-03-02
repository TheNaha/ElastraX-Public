import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { ModelRouter, getModelRouter, sanitizeMessagesForProvider } from '../src/utils/ModelRouter';
import type { AIChatMessage } from '../src/ai/client';

describe('ModelRouter', () => {
  const savedBaseUrl = process.env.AI_API_BASE_URL;
  const savedProviders = process.env.AI_PROVIDERS;

  beforeEach(() => {
    // Force single-provider mode so test isolation is guaranteed even when
    // AI_PROVIDERS is set in the real .env (Bun auto-loads .env during tests).
    delete process.env.AI_PROVIDERS;
    process.env.AI_API_BASE_URL = 'https://test-api.example.com/v1';
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_MODEL_NAME = 'test-model';
  });

  afterEach(() => {
    if (savedBaseUrl) {
      process.env.AI_API_BASE_URL = savedBaseUrl;
    } else {
      delete process.env.AI_API_BASE_URL;
    }
    if (savedProviders) {
      process.env.AI_PROVIDERS = savedProviders;
    } else {
      delete process.env.AI_PROVIDERS;
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

// ─── sanitizeMessagesForProvider unit tests ───────────────────────────────────

describe('sanitizeMessagesForProvider', () => {
  // Use `as any` for the content arrays so TS doesn't complain about the
  // test fixture literals — the runtime values are what we're testing here.
  const videoMessage: AIChatMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'Watch this' },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,...' } },
    ] as any,
  };

  const audioMessage: AIChatMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'Listen to this' },
      { type: 'audio_url', audio_url: { url: 'data:audio/ogg;base64,...' } },
    ] as any,
  };

  const imageMessage: AIChatMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'Look at this' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...' } },
    ] as any,
  };

  test('strips video_url when provider does not support video', () => {
    const result = sanitizeMessagesForProvider([videoMessage], { supportsVideo: false, supportsAudio: false });
    const content = result[0].content as any[];
    expect(content.some((p: any) => p.type === 'video_url')).toBe(false);
    expect(content.some((p: any) => p.type === 'text')).toBe(true);
    const textPart = content.find((p: any) => p.type === 'text' && p.text.includes('Video attached'));
    expect(textPart).toBeDefined();
  });

  test('strips audio_url when provider does not support audio', () => {
    const result = sanitizeMessagesForProvider([audioMessage], { supportsVideo: false, supportsAudio: false });
    const content = result[0].content as any[];
    expect(content.some((p: any) => p.type === 'audio_url')).toBe(false);
    const textPart = content.find((p: any) => p.type === 'text' && p.text.includes('Audio attached'));
    expect(textPart).toBeDefined();
  });

  test('preserves video_url when provider supports video', () => {
    const result = sanitizeMessagesForProvider([videoMessage], { supportsVideo: true, supportsAudio: true });
    const content = result[0].content as any[];
    expect(content.some((p: any) => p.type === 'video_url')).toBe(true);
  });

  test('always preserves image_url regardless of capabilities', () => {
    const result = sanitizeMessagesForProvider([imageMessage], { supportsVideo: false, supportsAudio: false });
    const content = result[0].content as any[];
    expect(content.some((p: any) => p.type === 'image_url')).toBe(true);
  });

  test('returns messages unchanged when provider supports all types', () => {
    const messages = [videoMessage, audioMessage, imageMessage];
    const result = sanitizeMessagesForProvider(messages, { supportsVideo: true, supportsAudio: true });
    // Same reference — no copy made when nothing needs sanitizing
    expect(result).toBe(messages);
  });

  test('does not mutate original messages', () => {
    const originalLen = (videoMessage.content as any[]).length;
    sanitizeMessagesForProvider([videoMessage], { supportsVideo: false, supportsAudio: false });
    expect((videoMessage.content as any[]).length).toBe(originalLen);
    expect((videoMessage.content as any[]).some((p: any) => p.type === 'video_url')).toBe(true);
  });

  test('string content is passed through untouched', () => {
    const strMsg: AIChatMessage = { role: 'user', content: 'plain text' };
    const result = sanitizeMessagesForProvider([strMsg], { supportsVideo: false, supportsAudio: false });
    expect(result[0].content).toBe('plain text');
  });
});
