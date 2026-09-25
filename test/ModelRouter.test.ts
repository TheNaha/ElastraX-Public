import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { AllProvidersOpenError } from '../src/ai/errors';
import {
  adaptChatRequest,
  ModelRouter,
  getModelRouter,
  sanitizeMessagesForProvider,
} from '../src/utils/ModelRouter';
import { healthMetrics } from '../src/utils/HealthMetrics';
import type { ChatCompletionEnvelope } from '../src/ai/types';
import type { AIChatMessage } from '../src/ai/client';

function envelope(content: string): ChatCompletionEnvelope {
  return {
    message: { role: 'assistant', content },
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    finishReason: 'stop',
    model: 'served-model',
    requestId: 'request-1',
    created: 1,
  };
}

function configureTwoProviders(): void {
  process.env.AI_PROVIDERS = 'primary,fallback';
  process.env.AI_PROVIDER_COOLDOWN_MS = '60000';
  process.env.AI_PRIMARY_BASE_URL = 'https://primary.example.com/v1';
  process.env.AI_PRIMARY_API_KEY = 'primary-key';
  process.env.AI_PRIMARY_MODEL = 'primary-model';
  process.env.AI_FALLBACK_BASE_URL = 'https://fallback.example.com/v1';
  process.env.AI_FALLBACK_API_KEY = 'fallback-key';
  process.env.AI_FALLBACK_MODEL = 'fallback-model';
}

interface InternalProvider {
  key: string;
  client: {
    chatCompletionEnvelope: (...args: unknown[]) => Promise<ChatCompletionEnvelope>;
    chatCompletionStream: (...args: unknown[]) => AsyncIterable<unknown>;
  };
}

function providersOf(router: ModelRouter): InternalProvider[] {
  return (router as unknown as { providers: InternalProvider[] }).providers;
}

describe('ModelRouter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AI_PROVIDERS;
    process.env.AI_API_BASE_URL = 'https://test-api.example.com/v1';
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_MODEL_NAME = 'test-model';
    delete process.env.AI_PROVIDER_COOLDOWN_MS;
    healthMetrics.reset();
    setSystemTime(new Date('2024-01-01T00:00:00Z'));
  });

  afterEach(() => {
    setSystemTime();
    process.env = originalEnv;
  });

  test('constructor and singleton load configured providers', () => {
    expect(() => new ModelRouter()).not.toThrow();
    expect(getModelRouter()).toBeInstanceOf(ModelRouter);
  });

  test('returns canonical envelope data and records token usage', async () => {
    const router = new ModelRouter();
    const providers = providersOf(router);
    const clientSpy = spyOn(providers[0]!.client, 'chatCompletionEnvelope')
      .mockResolvedValue(envelope('hello'));

    const result = await router.chatCompletionEnvelope([{ role: 'user', content: 'hi' }]);

    expect(result.message.content).toBe('hello');
    expect(result.provider).toEqual({ name: 'default', key: 'llm' });
    expect(healthMetrics.getMetrics().tokens['served-model']?.total).toBe(3);
    clientSpy.mockRestore();
  });

  test('preserves the legacy message-returning API', async () => {
    const router = new ModelRouter();
    const providers = providersOf(router);
    const clientSpy = spyOn(providers[0]!.client, 'chatCompletionEnvelope')
      .mockResolvedValue(envelope('hello'));
    const result = await router.chatCompletion([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('hello');
    clientSpy.mockRestore();
  });

  test('rejects empty responses after HTTP success', async () => {
    const router = new ModelRouter();
    const providers = providersOf(router);
    const clientSpy = spyOn(providers[0]!.client, 'chatCompletionEnvelope')
      .mockResolvedValue(envelope(''));
    await expect(router.chatCompletion([{ role: 'user', content: 'hi' }])).rejects.toThrow();
    clientSpy.mockRestore();
  });

  test('keeps a provider closed below the five-failure threshold', async () => {
    configureTwoProviders();
    const router = new ModelRouter();
    const providers = providersOf(router);
    const primarySpy = spyOn(providers[0]!.client, 'chatCompletionEnvelope')
      .mockRejectedValueOnce(new Error('primary down'))
      .mockResolvedValue(envelope('primary ok'));
    const fallbackSpy = spyOn(providers[1]!.client, 'chatCompletionEnvelope')
      .mockResolvedValue(envelope('fallback ok'));

    expect((await router.chatCompletion([{ role: 'user', content: 'one' }])).content).toBe('fallback ok');
    expect((await router.chatCompletion([{ role: 'user', content: 'two' }])).content).toBe('primary ok');
    expect(primarySpy).toHaveBeenCalledTimes(2);
    expect(fallbackSpy).toHaveBeenCalledTimes(1);
    primarySpy.mockRestore();
    fallbackSpy.mockRestore();
  });

  test('opens at five failures, applies jitter, and skips while open', async () => {
    configureTwoProviders();
    const router = new ModelRouter({ random: () => 0.5 });
    const providers = providersOf(router);
    const primarySpy = spyOn(providers[0]!.client, 'chatCompletionEnvelope')
      .mockRejectedValue(new Error('primary down'));
    const fallbackSpy = spyOn(providers[1]!.client, 'chatCompletionEnvelope')
      .mockResolvedValue(envelope('fallback ok'));

    for (let index = 0; index < 5; index++) {
      await router.chatCompletion([{ role: 'user', content: `message ${index}` }]);
    }
    expect(router.getProviderCircuit('llm:primary').state).toBe('open');
    expect(router.getProviderCircuit('llm:primary').openUntil).toBe(Date.now() + 60_000);

    await router.chatCompletion([{ role: 'user', content: 'after open' }]);
    expect(primarySpy).toHaveBeenCalledTimes(5);
    expect(fallbackSpy).toHaveBeenCalledTimes(6);
    primarySpy.mockRestore();
    fallbackSpy.mockRestore();
  });

  test('allows one half-open probe after cooldown and closes on success', async () => {
    configureTwoProviders();
    const router = new ModelRouter({ random: () => 0.5 });
    const providers = providersOf(router);
    let probeEntered = false;
    let releaseProbe: (() => void) | undefined;
    const probeGate = new Promise<void>(resolve => { releaseProbe = resolve; });
    let primaryCalls = 0;
    const primarySpy = spyOn(providers[0]!.client, 'chatCompletionEnvelope')
      .mockImplementation(async () => {
        primaryCalls++;
        if (primaryCalls <= 5) throw new Error('primary down');
        probeEntered = true;
        await probeGate;
        return envelope('primary recovered');
      });
    const fallbackSpy = spyOn(providers[1]!.client, 'chatCompletionEnvelope')
      .mockResolvedValue(envelope('fallback ok'));

    for (let index = 0; index < 5; index++) {
      await router.chatCompletion([{ role: 'user', content: `message ${index}` }]);
    }
    setSystemTime(new Date('2024-01-01T00:02:00Z'));

    const probe = router.chatCompletion([{ role: 'user', content: 'probe' }]);
    while (!probeEntered) await Promise.resolve();
    const concurrent = await router.chatCompletion([{ role: 'user', content: 'concurrent' }]);
    expect(concurrent.content).toBe('fallback ok');
    expect(primaryCalls).toBe(6);
    releaseProbe?.();

    expect((await probe).content).toBe('primary recovered');
    expect(router.getProviderCircuit('llm:primary').state).toBe('closed');
    primarySpy.mockRestore();
    fallbackSpy.mockRestore();
  });

  test('fails fast when the only circuit is open', async () => {
    const router = new ModelRouter();
    const providers = providersOf(router);
    const clientSpy = spyOn(providers[0]!.client, 'chatCompletionEnvelope')
      .mockRejectedValue(new Error('down'));

    for (let index = 0; index < 5; index++) {
      await expect(router.chatCompletion([{ role: 'user', content: 'failure' }])).rejects.toThrow('down');
    }
    await expect(router.chatCompletion([{ role: 'user', content: 'fail fast' }]))
      .rejects.toBeInstanceOf(AllProvidersOpenError);
    expect(clientSpy).toHaveBeenCalledTimes(5);
    clientSpy.mockRestore();
  });

  test('uses unique provider keys even when names repeat', () => {
    process.env.AI_PROVIDERS = 'primary,primary';
    process.env.AI_PRIMARY_BASE_URL = 'https://primary.example.com/v1';
    process.env.AI_PRIMARY_API_KEY = 'key';
    process.env.AI_PRIMARY_MODEL = 'model';
    const router = new ModelRouter();
    const keys = router.getProviders().map(provider => provider.key);
    expect(new Set(keys).size).toBe(2);
  });

  test('records final streaming token usage', async () => {
    const router = new ModelRouter();
    const providers = providersOf(router);
    const clientSpy = spyOn(providers[0]!.client, 'chatCompletionStream').mockImplementation(
      async function* () {
        yield {
          id: 'stream-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'stream-model',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
          usage: null,
        };
        yield {
          id: 'stream-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'stream-model',
          choices: [],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        };
        yield {
          id: 'stream-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'stream-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: null,
        };
      },
    );

    let streamedChunks = 0;
    for await (const chunk of router.chatCompletionStream([{ role: 'user', content: 'hi' }])) {
      if (chunk.usage) streamedChunks++;
    }
    expect(streamedChunks).toBe(1);
    expect(healthMetrics.getMetrics().tokens['stream-model']?.total).toBe(5);
    clientSpy.mockRestore();
  });

  test('does not fall back after streaming output has started', async () => {
    configureTwoProviders();
    const router = new ModelRouter();
    const providers = providersOf(router);
    const primarySpy = spyOn(providers[0]!.client, 'chatCompletionStream').mockImplementation(
      async function* () {
        yield { choices: [{ delta: { content: 'partial' } }] };
        throw new Error('stream broke');
      },
    );
    const fallbackSpy = spyOn(providers[1]!.client, 'chatCompletionStream').mockImplementation(
      async function* () {
        yield { choices: [{ delta: { content: 'fallback' } }] };
      },
    );

    const chunks: unknown[] = [];
    const collect = async () => {
      for await (const chunk of router.chatCompletionStream([{ role: 'user', content: 'hi' }])) {
        chunks.push(chunk);
      }
    };

    await expect(collect()).rejects.toThrow('stream broke');
    expect(chunks).toHaveLength(1);
    expect(fallbackSpy).not.toHaveBeenCalled();
    primarySpy.mockRestore();
    fallbackSpy.mockRestore();
  });
});

describe('provider request adaptation', () => {
  const videoMessage: AIChatMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'Watch' },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,x' } },
    ],
  };
  const imageMessage: AIChatMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'Look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
    ],
  };

  test('sanitizes unsupported image, video, and audio parts without mutation', () => {
    const messages: AIChatMessage[] = [
      videoMessage,
      imageMessage,
      { role: 'user', content: [{ type: 'audio_url', audio_url: { url: 'data:audio/ogg;base64,x' } }] },
    ];
    const result = sanitizeMessagesForProvider(messages, {
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
    });
    expect(JSON.stringify(result)).not.toContain('base64');
    expect(messages[0]?.content).toBe(videoMessage.content);
  });

  test('drops tools for providers without tool-call support', () => {
    const tool = {
      type: 'function' as const,
      function: {
        name: 'noop',
        description: '',
        parameters: { type: 'object' as const, properties: {}, required: [] },
      },
    };
    const adapted = adaptChatRequest([{ role: 'user', content: 'hi' }], [tool], {
      supportsImage: true,
      supportsVideo: true,
      supportsAudio: true,
      supportsTools: false,
    });
    expect(adapted.tools).toBeUndefined();
  });
});
