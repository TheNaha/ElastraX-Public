import { expect, test, describe, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';
import { TranscribeTool } from '../src/tools/TranscribeTool';
import * as fs from 'fs';
import { mediaStorageDeps } from '../src/utils/MediaStorage';

describe('TranscribeTool', () => {
  const originalFetch = global.fetch;
  const savedEndpoint = process.env.TRANSCRIBE_ENDPOINT;
  const savedApiKey = process.env.TRANSCRIBE_API_KEY;
  let existsSpy: ReturnType<typeof spyOn>;
  let statSpy: ReturnType<typeof spyOn>;
  let openSpy: ReturnType<typeof spyOn>;
  let mediaReadCount: number;

  beforeEach(() => {
    global.fetch = originalFetch;
    process.env.TRANSCRIBE_ENDPOINT = savedEndpoint;
    process.env.TRANSCRIBE_API_KEY = savedApiKey;
    existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    statSpy = spyOn(mediaStorageDeps, 'stat').mockResolvedValue({ isFile: () => true, size: 8 } as never);
    mediaReadCount = 0;
    openSpy = spyOn(mediaStorageDeps, 'open').mockResolvedValue({
      read: async (buffer: Buffer) => {
        if (mediaReadCount++ > 0) return { bytesRead: 0 };
        buffer.set(Buffer.from([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0]));
        return { bytesRead: 8 };
      },
      close: async () => undefined,
    } as never);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.TRANSCRIBE_ENDPOINT = savedEndpoint;
    process.env.TRANSCRIBE_API_KEY = savedApiKey;
    existsSpy.mockRestore();
    statSpy.mockRestore();
    openSpy.mockRestore();
  });

  const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
    platform: 'whatsapp',
    chatId: 'chat-1',
    senderId: 'user-1',
    senderName: 'User',
    text: '',
    isGroup: false,
    isBotMentioned: false,
    hasMedia: false,
    language: 'en',
    reply: mock(async () => {}),
    react: mock(async () => {}),
    mediaReady: Promise.resolve(),
    mediaPath: '/tmp/audio.ogg',
    mimeType: 'audio/ogg',
    rawMessage: {},
    ...overrides,
  } as MessageContext);

  test('should have basic properties', () => {
    const tool = new TranscribeTool();
    expect(tool.name).toBe('transcribe_audio');
    expect(tool.description).toBeString();
    expect(tool.aliases).toContain('transcribe');
    expect(tool.aliases).toContain('stt');
    expect(tool.category).toBe('utility');
    expect(tool.permissions).toBe('user');
  });

  test('definition should match OpenAI schema', () => {
    const tool = new TranscribeTool();
    const def = tool.definition;

    expect(def.type).toBe('function');
    expect(def.function.name).toBe('transcribe_audio');
    expect(def.function.parameters.type).toBe('object');
  });

  test('should return not_supported when TRANSCRIBE_ENDPOINT is not set', async () => {
    delete process.env.TRANSCRIBE_ENDPOINT;
    const tool = new TranscribeTool();
    const ctx = createMockCtx();
    const result = await tool.execute({}, ctx);

    expect(result).toContain('not configured');
  });

  test('should return transcription when endpoint is configured', async () => {
    process.env.TRANSCRIBE_ENDPOINT = 'https://api.example.com/transcribe';
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ text: 'hello world' }),
    })) as unknown as typeof fetch;

    const tool = new TranscribeTool();
    const ctx = createMockCtx();
    const result = await tool.execute({}, ctx);

    expect(result).toContain('hello world');
  });

  test('should return error when fetch fails', async () => {
    process.env.TRANSCRIBE_ENDPOINT = 'https://api.example.com/transcribe';
    global.fetch = mock(async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch;

    const tool = new TranscribeTool();
    const ctx = createMockCtx();
    const result = await tool.execute({}, ctx);

    expect(result).toContain('failed');
  });

  test('should return no_media when no media path is available', async () => {
    process.env.TRANSCRIBE_ENDPOINT = 'https://api.example.com/transcribe';
    existsSpy.mockReturnValue(false);

    const tool = new TranscribeTool();
    const ctx = createMockCtx({
      mediaPath: undefined,
      quoted: undefined,
    });
    const result = await tool.execute({}, ctx);

    expect(result).toContain('attach');
  });
});
