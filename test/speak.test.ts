/**
 * Tests for text-to-speech synthesis and the SpeakTool delivery path.
 *
 * The delivery assertions matter most: a TTS feature that synthesises audio but
 * never reaches `sendMedia` is the same "green test, dead feature" shape this
 * codebase already shipped twice. So these drive the tool and assert the buffer
 * arrives at the context with voice-note options set.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { readTtsConfig, isTtsConfigured, estimateDurationSeconds, synthesizeSpeech } from '../src/utils/tts';
import { SpeakTool } from '../src/tools/SpeakTool';
import { FFmpegConverter, ffmpegConverterDeps } from '../src/utils/FFmpegConverter';
import { HttpClientError, BaseHttpClient } from '../src/utils/BaseHttpClient';
import type { BoundedProcessOptions } from '../src/providers/process';
import type { MessageContext } from '../src/core/MessageContext';

const originalFetch = globalThis.fetch;
const originalRunProcess = ffmpegConverterDeps.runProcess;
const originalFs = {
  mkdir: ffmpegConverterDeps.fs.mkdir,
  chmod: ffmpegConverterDeps.fs.chmod,
  writeFile: ffmpegConverterDeps.fs.writeFile,
  stat: ffmpegConverterDeps.fs.stat,
  readFile: ffmpegConverterDeps.fs.readFile,
  rm: ffmpegConverterDeps.fs.rm,
};

function stubFsOutput(): void {
  ffmpegConverterDeps.fs.mkdir = (async () => {}) as never;
  ffmpegConverterDeps.fs.chmod = (async () => {}) as never;
  ffmpegConverterDeps.fs.writeFile = (async () => {}) as never;
  ffmpegConverterDeps.fs.stat = (async () => ({ isFile: () => true, size: 8 })) as never;
  ffmpegConverterDeps.fs.readFile = (async () => Buffer.from('opus-bytes')) as never;
  ffmpegConverterDeps.fs.rm = (async () => {}) as never;
}

function restoreFs(): void {
  ffmpegConverterDeps.fs.mkdir = originalFs.mkdir;
  ffmpegConverterDeps.fs.chmod = originalFs.chmod;
  ffmpegConverterDeps.fs.writeFile = originalFs.writeFile;
  ffmpegConverterDeps.fs.stat = originalFs.stat;
  ffmpegConverterDeps.fs.readFile = originalFs.readFile;
  ffmpegConverterDeps.fs.rm = originalFs.rm;
}

function audioResponse(body = Buffer.from('fake-mp3')): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
}

function context(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    platform: 'whatsapp',
    chatId: 'chat-1',
    senderId: 'sender-1',
    isGroup: false,
    language: 'en',
    hasMedia: false,
    signal: undefined,
    react: mock(async () => undefined),
    sendMedia: mock(async () => undefined),
    reply: mock(async () => undefined),
    ...overrides,
  } as unknown as MessageContext;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  ffmpegConverterDeps.runProcess = originalRunProcess;
  restoreFs();
});

describe('TTS configuration', () => {
  test('defaults to the OpenAI-compatible endpoint', () => {
    const config = readTtsConfig({} as NodeJS.ProcessEnv);
    expect(config.provider).toBe('openai');
    expect(config.baseUrl).toBe('https://api.openai.com');
    expect(config.voice).toBe('alloy');
  });

  test('strips a trailing slash from the base URL', () => {
    expect(readTtsConfig({ TTS_BASE_URL: 'http://localhost:9000/' } as NodeJS.ProcessEnv).baseUrl)
      .toBe('http://localhost:9000');
  });

  test('selects the ElevenLabs default endpoint and requires a voice', () => {
    const config = readTtsConfig({ TTS_PROVIDER: 'elevenlabs', TTS_API_KEY: 'k' } as NodeJS.ProcessEnv);
    expect(config.baseUrl).toBe('https://api.elevenlabs.io');
    // A voice id cannot be guessed, so this counts as unconfigured.
    expect(isTtsConfigured(config)).toBe(false);
    expect(isTtsConfigured({ ...config, voice: 'voice-id' })).toBe(true);
  });

  test('is unconfigured without an API key', () => {
    expect(isTtsConfigured(readTtsConfig({} as NodeJS.ProcessEnv))).toBe(false);
    expect(isTtsConfigured(readTtsConfig({ TTS_API_KEY: 'k' } as NodeJS.ProcessEnv))).toBe(true);
  });

  test('clamps the character limit and timeout to sane ranges', () => {
    // readIntegerEnv rejects out-of-range values and returns the fallback, so an
    // absurd value never becomes an absurd budget.
    const config = readTtsConfig({ TTS_MAX_CHARS: '0', TTS_TIMEOUT_MS: '99999999' } as NodeJS.ProcessEnv);
    expect(config.maxChars).toBe(2000);
    expect(config.timeoutMs).toBe(60_000);
    const inRange = readTtsConfig({ TTS_MAX_CHARS: '500', TTS_TIMEOUT_MS: '9000' } as NodeJS.ProcessEnv);
    expect(inRange.maxChars).toBe(500);
    expect(inRange.timeoutMs).toBe(9000);
  });

  test('estimates a non-zero duration', () => {
    expect(estimateDurationSeconds('hello')).toBeGreaterThan(0);
    expect(estimateDurationSeconds('')).toBeGreaterThan(0);
    expect(estimateDurationSeconds('a'.repeat(1450))).toBe(100);
  });
});

describe('synthesizeSpeech', () => {
  beforeEach(() => {
    stubFsOutput();
    ffmpegConverterDeps.runProcess = (async () => undefined) as never;
  });

  const configured = readTtsConfig({ TTS_API_KEY: 'test-key' } as NodeJS.ProcessEnv);

  test('refuses when unconfigured', async () => {
    await expect(synthesizeSpeech({ text: 'hi', config: readTtsConfig({} as NodeJS.ProcessEnv) }))
      .rejects.toThrow(/not configured/i);
  });

  test('refuses empty text', async () => {
    await expect(synthesizeSpeech({ text: '   ', config: configured })).rejects.toThrow(/nothing to speak/i);
  });

  test('refuses text over the character limit rather than truncating silently', async () => {
    const limited = { ...configured, maxChars: 10 };
    await expect(synthesizeSpeech({ text: 'x'.repeat(50), config: limited }))
      .rejects.toThrow(/exceeds the 10 character limit/);
  });

  test('posts to the OpenAI-compatible speech endpoint and normalises to opus', async () => {
    let requestedUrl = '';
    let requestedBody: Record<string, unknown> = {};
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return audioResponse();
    }) as unknown as typeof fetch;

    const audio = await synthesizeSpeech({ text: 'hello there', config: configured });

    expect(requestedUrl).toBe('https://api.openai.com/v1/audio/speech');
    expect(requestedBody.input).toBe('hello there');
    expect(requestedBody.model).toBe('tts-1');
    expect(audio.mimeType).toContain('audio/ogg');
    expect(audio.extension).toBe('ogg');
    expect(audio.buffer.toString()).toBe('opus-bytes');
  });

  test('passes a per-call voice override', async () => {
    let requestedBody: Record<string, unknown> = {};
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return audioResponse();
    }) as unknown as typeof fetch;

    await synthesizeSpeech({ text: 'hi', voice: 'nova', config: configured });
    expect(requestedBody.voice).toBe('nova');
  });

  test('rejects an empty audio body instead of sending an empty voice note', async () => {
    globalThis.fetch = mock(async () => new Response(Buffer.alloc(0), { status: 200 })) as unknown as typeof fetch;
    await expect(synthesizeSpeech({ text: 'hi', config: configured })).rejects.toThrow(/empty audio body/i);
  });

  test('surfaces an upstream HTTP error', async () => {
    globalThis.fetch = mock(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    await expect(synthesizeSpeech({ text: 'hi', config: configured })).rejects.toThrow(/401/);
  });

  test('still returns audio when opus normalisation fails', async () => {
    // Losing the native voice bubble is acceptable; losing the reply is not.
    ffmpegConverterDeps.runProcess = (async () => { throw new Error('ffmpeg unavailable'); }) as never;
    globalThis.fetch = mock(async () => audioResponse()) as unknown as typeof fetch;

    const audio = await synthesizeSpeech({ text: 'hi', config: configured });
    expect(audio.buffer.toString()).toBe('fake-mp3');
    expect(audio.extension).toBe('mp3');
    expect(audio.mimeType).toBe('audio/mp3');
  });

  test('sends the converted file back through the ffmpeg seam', async () => {
    const calls: BoundedProcessOptions[] = [];
    ffmpegConverterDeps.runProcess = (async (options: BoundedProcessOptions) => { calls.push(options); return undefined; }) as never;
    globalThis.fetch = mock(async () => audioResponse()) as unknown as typeof fetch;

    await synthesizeSpeech({ text: 'hi', config: configured });
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    // convert() wraps the requested filter in its own ffmpeg invocation, so the
    // opus arguments appear as a contiguous run rather than the whole argv.
    expect(args.join(' ')).toContain('-vn -acodec libopus');
    // The output container is chosen by the trailing path argument.
    expect(args[args.length - 1]).toMatch(/\.ogg$/);
    expect(args.join(' ')).toContain('input.mp3');
  });
});

describe('SpeakTool delivery', () => {
  beforeEach(() => {
    stubFsOutput();
    ffmpegConverterDeps.runProcess = (async () => undefined) as never;
  });

  const configuredEnv = { TTS_API_KEY: 'test-key' } as NodeJS.ProcessEnv;

  test('is not registered until a provider is configured', () => {
    const previous = { ...process.env };
    for (const key of ['TTS_API_KEY', 'TTS_PROVIDER', 'TTS_BASE_URL']) delete process.env[key];
    try {
      const tool = new SpeakTool();
      // The registry filters on isEnabled() at load time, so an unconfigured bot
      // never lists the tool at all — it cannot offer a voice reply it cannot
      // deliver, and /speak reads as an unknown command.
      expect(tool.isEnabled()).toBe(false);
      expect(tool.isConfigured()).toBe(false);
    } finally {
      Object.assign(process.env, previous);
    }
  });

  test('is registered once a provider is configured', () => {
    const previous = { ...process.env };
    Object.assign(process.env, { TTS_API_KEY: 'test-key' });
    try {
      const tool = new SpeakTool();
      expect(tool.isEnabled()).toBe(true);
      expect(tool.isConfigured()).toBe(true);
    } finally {
      Object.assign(process.env, previous);
    }
  });

  test('is absent from the registry when unconfigured, and present when configured', async () => {
    const previous = { ...process.env };
    for (const key of ['TTS_API_KEY', 'TTS_PROVIDER', 'TTS_BASE_URL']) delete process.env[key];
    try {
      const registry = await import('../src/tools/registry');
      await registry.reloadRegistry();
      expect(registry.tools.some(t => t.name === 'speak')).toBe(false);
      expect(registry.getToolByAliasOrName('speak')).toBeUndefined();
    } finally {
      Object.assign(process.env, { TTS_API_KEY: 'test-key' });
    }
    try {
      const registry = await import('../src/tools/registry');
      await registry.reloadRegistry();
      expect(registry.tools.some(t => t.name === 'speak')).toBe(true);
      expect(registry.getToolByAliasOrName('speak')).toBeDefined();
    } finally {
      Object.assign(process.env, previous);
      const registry = await import('../src/tools/registry');
      await registry.reloadRegistry();
    }
  });

  test('tells the user how to enable it when unconfigured, without calling the network', async () => {
    const previous = { ...process.env };
    for (const key of ['TTS_API_KEY', 'TTS_PROVIDER', 'TTS_BASE_URL']) delete process.env[key];
    globalThis.fetch = mock(async () => { throw new Error('must not be called'); }) as unknown as typeof fetch;
    try {
      const result = await new SpeakTool().execute({ text: 'hello' }, context());
      expect(result).toContain('TTS_API_KEY');
    } finally {
      Object.assign(process.env, previous);
    }
  });

  test('rejects empty text without calling the provider', async () => {
    const previous = { ...process.env };
    Object.assign(process.env, configuredEnv);
    globalThis.fetch = mock(async () => { throw new Error('must not be called'); }) as unknown as typeof fetch;
    try {
      const result = await new SpeakTool().execute({ text: '   ' }, context());
      expect(result).toContain('nothing to speak');
    } finally {
      Object.assign(process.env, previous);
    }
  });

  test('delivers the audio to the chat as a voice note', async () => {
    const previous = { ...process.env };
    Object.assign(process.env, configuredEnv);
    globalThis.fetch = mock(async () => audioResponse()) as unknown as typeof fetch;
    const sent: Array<{ buffer: Buffer; options: Record<string, unknown> }> = [];
    const ctx = context({
      sendMedia: mock(async (buffer: Buffer, options: Record<string, unknown>) => { sent.push({ buffer, options }); }) as never,
    });
    try {
      const result = await new SpeakTool().execute({ text: 'hello there' }, ctx);
      expect(result).toBe('');
      expect(sent).toHaveLength(1);
      // ptt is what makes WhatsApp render a native voice bubble.
      expect(sent[0]!.options.ptt).toBe(true);
      expect(String(sent[0]!.options.mimetype)).toContain('audio/ogg');
      expect(sent[0]!.buffer.byteLength).toBeGreaterThan(0);
      expect(typeof sent[0]!.options.durationSeconds).toBe('number');
      expect(String(sent[0]!.options.filename)).toMatch(/\.ogg$/);
    } finally {
      Object.assign(process.env, previous);
    }
  });

  test('reports a synthesis failure to the user instead of throwing', async () => {
    const previous = { ...process.env };
    Object.assign(process.env, configuredEnv);
    globalThis.fetch = mock(async () => new Response('bad', { status: 500 })) as unknown as typeof fetch;
    try {
      const result = await new SpeakTool().execute({ text: 'hello' }, context());
      expect(result).toContain('500');
    } finally {
      Object.assign(process.env, previous);
    }
  });

  test('exposes a schema the validator accepts', async () => {
    const { validateToolArguments } = await import('../src/tools/ParameterValidator');
    const result = validateToolArguments(new SpeakTool(), { text: 'hello' });
    expect(result.valid).toBe(true);
    // Unknown keys must be rejected, not silently ignored.
    expect(validateToolArguments(new SpeakTool(), { text: 'hello', bogus: 1 }).valid).toBe(false);
  });
});

describe('BaseHttpClient binary responses', () => {
  class BinaryClient extends BaseHttpClient {
    async fetchBinary(signal?: AbortSignal): Promise<Buffer> {
      this.expectBinary('POST', '/binary', 32);
      return this.post<Buffer>('/binary', { a: 1 }, undefined, { signal });
    }

    async fetchJson(path: string): Promise<unknown> {
      return this.post<unknown>(path, { a: 1 });
    }
  }

  afterEach(() => { globalThis.fetch = originalFetch; });

  test('returns raw bytes for a declared binary path', async () => {
    globalThis.fetch = mock(async () => new Response(Buffer.from('BINARY'), { status: 200 })) as unknown as typeof fetch;
    const client = new BinaryClient('https://example.test');
    const buffer = await client.fetchBinary();
    expect(buffer.toString()).toBe('BINARY');
  });

  test('enforces the declared size cap', async () => {
    globalThis.fetch = mock(async () => new Response(Buffer.alloc(128), { status: 200 })) as unknown as typeof fetch;
    const client = new BinaryClient('https://example.test');
    await expect(client.fetchBinary()).rejects.toThrow(/exceeds 32 bytes/);
  });

  test('rejects a content-length above the cap before reading the body', async () => {
    globalThis.fetch = mock(async () => new Response(Buffer.alloc(4), {
      status: 200, headers: { 'content-length': '9999' },
    })) as unknown as typeof fetch;
    const client = new BinaryClient('https://example.test');
    await expect(client.fetchBinary()).rejects.toBeInstanceOf(HttpClientError);
  });

  test('still treats an undeclared path as JSON', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const client = new BinaryClient('https://example.test');
    // fetchBinary declares /binary only; a different path must not return bytes.
    await expect(client.fetchJson('/other')).resolves.toEqual({ ok: true });
  });
});

describe('FFmpegConverter opus support', () => {
  beforeEach(() => {
    stubFsOutput();
    ffmpegConverterDeps.runProcess = (async () => undefined) as never;
  });

  test('accepts the opus argument set the TTS path uses', async () => {
    const result = await FFmpegConverter.convert(Buffer.from('mp3'), ['-vn', '-acodec', 'libopus'], 'mp3', 'ogg');
    expect(result.toString()).toBe('opus-bytes');
  });
});
