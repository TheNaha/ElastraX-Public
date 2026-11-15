/**
 * Tests for the Telegram provider and the platform-aware owner fix.
 *
 * The two behaviours worth pinning:
 *  - `start()` must not report ready before it has authenticated, since the
 *    runtime admits providers into the sender registry on that signal. The
 *    WhatsApp provider used to resolve while still `starting` and was dropped on
 *    every boot, so this is the exact regression to avoid.
 *  - a platform whose ids cannot match `BOT_OWNER_JID` must still resolve an
 *    owner, otherwise a fresh Telegram or Discord deployment has no `owner` and
 *    every owner-only tool is unreachable there.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import type { MessageContext } from '../src/core/MessageContext';

const { AuthService } = await import('../src/utils/AuthService');
const { chunkTelegramText, TELEGRAM_TEXT_LIMIT } = await import('../src/providers/telegramText');
const { TelegramProvider, telegramProviderDeps } = await import('../src/providers/telegram');

const originalToken = process.env.TELEGRAM_BOT_TOKEN;
const originalOwnerJid = process.env.BOT_OWNER_JID;
const originalOwnerTelegram = process.env.BOT_OWNER_TELEGRAM_ID;
const originalOwnerDiscord = process.env.BOT_OWNER_DISCORD_ID;

function clearOwnerEnv(): void {
  delete process.env.BOT_OWNER_JID;
  delete process.env.BOT_OWNER_TELEGRAM_ID;
  delete process.env.BOT_OWNER_DISCORD_ID;
}

beforeEach(() => {
  telegramProviderDeps.createBot = undefined;
  clearOwnerEnv();
});

describe('platform-aware owner resolution', () => {
  test('falls back to BOT_OWNER_JID when no platform-specific id is set', () => {
    process.env.BOT_OWNER_JID = '628123@s.whatsapp.net';
    expect(AuthService.resolveOwnerId('whatsapp')).toBe('628123@s.whatsapp.net');
    // With nothing platform-specific configured, the shared variable is used.
    expect(AuthService.resolveOwnerId('discord')).toBe('628123@s.whatsapp.net');
    expect(AuthService.resolveOwnerId('telegram')).toBe('628123@s.whatsapp.net');
  });

  test('a Telegram id never matches the WhatsApp-shaped variable', () => {
    // The bug this replaces: a numeric snowflake can never equal a JID, so a
    // fresh Telegram deployment silently had zero owners.
    process.env.BOT_OWNER_JID = '628123@s.whatsapp.net';
    expect(AuthService.resolveOwnerId('telegram')).not.toBe('123456789');
    process.env.BOT_OWNER_TELEGRAM_ID = '123456789';
    expect(AuthService.resolveOwnerId('telegram')).toBe('123456789');
    // …and WhatsApp is unaffected by the Telegram variable.
    expect(AuthService.resolveOwnerId('whatsapp')).toBe('628123@s.whatsapp.net');
  });

  test('supports a platform-specific Discord id', () => {
    process.env.BOT_OWNER_JID = '628123@s.whatsapp.net';
    process.env.BOT_OWNER_DISCORD_ID = '222222222222222222';
    expect(AuthService.resolveOwnerId('discord')).toBe('222222222222222222');
    expect(AuthService.resolveOwnerId('whatsapp')).toBe('628123@s.whatsapp.net');
  });

  test('trims whitespace and treats blank as unset', () => {
    process.env.BOT_OWNER_TELEGRAM_ID = '   ';
    expect(AuthService.resolveOwnerId('telegram')).toBeUndefined();
    process.env.BOT_OWNER_TELEGRAM_ID = ' 999 ';
    expect(AuthService.resolveOwnerId('telegram')).toBe('999');
  });

  test('returns undefined when nothing is configured', () => {
    clearOwnerEnv();
    expect(AuthService.resolveOwnerId('whatsapp')).toBeUndefined();
  });
});

describe('chunkTelegramText', () => {
  test('passes short text through unchanged', () => {
    expect(chunkTelegramText('hello')).toEqual(['hello']);
  });

  test('returns nothing for empty input', () => {
    expect(chunkTelegramText('')).toEqual([]);
  });

  test('splits text over the limit and loses nothing', () => {
    const text = 'a'.repeat(TELEGRAM_TEXT_LIMIT * 2 + 100);
    const chunks = chunkTelegramText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(chunks.join('').length).toBe(text.length);
  });

  test('prefers a paragraph boundary when one is available', () => {
    const paragraph = 'x'.repeat(4000);
    const chunks = chunkTelegramText(`${paragraph}\n\n${'y'.repeat(4000)}`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.endsWith('x')).toBe(true);
  });

  test('hard-splits unbroken text with no whitespace', () => {
    const chunks = chunkTelegramText('z'.repeat(TELEGRAM_TEXT_LIMIT + 50));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBe(TELEGRAM_TEXT_LIMIT);
  });

  test('respects a custom limit', () => {
    const chunks = chunkTelegramText('a'.repeat(250), 100);
    expect(chunks.every(chunk => chunk.length <= 100)).toBe(true);
  });
});

describe('TelegramProvider lifecycle', () => {
  test('reports not_configured without a token instead of throwing', async () => {
    // A deployment need not run Telegram; the gap must be visible in readiness
    // rather than aborting boot.
    delete process.env.TELEGRAM_BOT_TOKEN;
    const provider = new TelegramProvider();
    await provider.start();
    expect(provider.status).toBe('not_configured');
    expect(provider.isOperational).toBe(false);
    expect(provider.lastError).toBeNull();
  });

  test('reports the platform name', () => {
    expect(new TelegramProvider().name).toBe('telegram');
  });

  test('does not report running until the API authenticates', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    let fireOnStart: (() => void) | undefined;
    telegramProviderDeps.createBot = () => ({
      on: () => undefined,
      api: {} as never,
      stop: () => undefined,
      start: async (options?: { onStart?: (info: { id: number; username: string }) => Promise<void> }) => {
        // Long polling blocks until the test releases it, then grammy would
        // report the authenticated bot through onStart.
        await new Promise<void>(resolve => { fireOnStart = resolve; });
        await options?.onStart?.({ id: 777, username: 'elastrax_bot' });
      },
    }) as never;

    const provider = new TelegramProvider();
    const started = provider.start();
    // Give the start() body a tick to register handlers and enter polling.
    await new Promise(resolve => setTimeout(resolve, 10));
    // The whole point: still starting, so the runtime must not admit it yet.
    expect(provider.status).toBe('starting');
    expect(provider.isOperational).toBe(false);

    (fireOnStart as (() => void) | undefined)?.();
    await started;
    // Only after the API authenticated may the provider be considered usable.
    expect(provider.status).toBe('running');
    expect(provider.isOperational).toBe(true);
    await provider.stop();
    expect(provider.status).toBe('stopped');
  });

  test('stop() is safe when never started', async () => {
    const provider = new TelegramProvider();
    await provider.stop();
    expect(provider.status).toBe('stopped');
  });

  test('sendMessage before start throws a lifecycle error', async () => {
    const provider = new TelegramProvider();
    await expect(provider.sendMessage('123', 'hi')).rejects.toThrow(/telegram/i);
  });

  test('context reply chunks oversized text across multiple messages', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    const sentMessages: Array<{ chatId: string; text: string; options: unknown }> = [];
    let messageCallback: ((ctx: unknown) => Promise<void>) | undefined;
    telegramProviderDeps.createBot = () => ({
      on: (event: string, handler: (ctx: unknown) => Promise<void>) => {
        if (event === 'message') messageCallback = handler;
      },
      api: {
        sendMessage: async (chatId: string, text: string, options: unknown) => {
          sentMessages.push({ chatId, text, options });
          return { message_id: 100 + sentMessages.length };
        },
      } as never,
      stop: () => undefined,
      start: async (options?: { onStart?: (info: { id: number; username: string }) => Promise<void> }) => {
        await options?.onStart?.({ id: 777, username: 'elastrax_bot' });
      },
    }) as never;

    const provider = new TelegramProvider();
    let receivedContext: MessageContext | null = null;
    provider.onMessage(async ctx => {
      receivedContext = ctx;
    });

    await provider.start();
    expect(messageCallback).toBeDefined();

    await messageCallback!({
      chat: { id: 12345, type: 'private' },
      from: { id: 67890, first_name: 'TestUser', is_bot: false },
      message: { message_id: 42, text: 'hello', date: 1000, from: { id: 67890, first_name: 'TestUser' }, entities: [] },
      date: 1000,
    });

    expect(receivedContext).not.toBeNull();
    const longText = 'x'.repeat(TELEGRAM_TEXT_LIMIT * 2 + 50);
    await receivedContext!.reply(longText);

    expect(sentMessages.length).toBeGreaterThanOrEqual(3);
    const firstOpts = sentMessages[0]?.options as { reply_parameters?: { message_id?: number } } | undefined;
    const secondOpts = sentMessages[1]?.options as { reply_parameters?: { message_id?: number } } | undefined;
    expect(firstOpts?.reply_parameters).toEqual({ message_id: 42 });
    expect(secondOpts?.reply_parameters).toBeUndefined();

    // Cross-chat send via sendToChat should omit reply_parameters
    sentMessages.length = 0;
    const sendToChat = receivedContext!.sendToChat;
    expect(sendToChat).toBeDefined();
    await sendToChat!('other-chat-999', 'cross-chat message');
    expect(sentMessages[0]?.chatId).toBe('other-chat-999');
    const crossOpts = sentMessages[0]?.options as { reply_parameters?: { message_id?: number } } | undefined;
    expect(crossOpts?.reply_parameters).toBeUndefined();

    await provider.stop();
  });

  /**
   * Telegram answers 400 "message to be replied not found" when the original is
   * deleted for everyone in the seconds before the answer. The whole reply used
   * to be lost; it must fall back to a plain send.
   */
  test('retries the first chunk without reply_parameters when the replied message is gone', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    const sent: Array<{ text: string; options: unknown }> = [];
    let messageCallback: ((ctx: unknown) => Promise<void>) | undefined;
    telegramProviderDeps.createBot = () => ({
      on: (event: string, handler: (ctx: unknown) => Promise<void>) => {
        if (event === 'message') messageCallback = handler;
      },
      api: {
        sendMessage: async (_chatId: string, text: string, options?: unknown) => {
          const replyParameters = (options as { reply_parameters?: unknown } | undefined)?.reply_parameters;
          if (replyParameters) {
            throw Object.assign(new Error('Bad Request: message to be replied not found'), {
              description: 'Bad Request: message to be replied not found',
            });
          }
          sent.push({ text, options });
          return { message_id: 500 + sent.length };
        },
      } as never,
      stop: () => undefined,
      start: async (options?: { onStart?: (info: { id: number; username: string }) => Promise<void> }) => {
        await options?.onStart?.({ id: 777, username: 'elastrax_bot' });
      },
    }) as never;

    const provider = new TelegramProvider();
    let receivedContext: MessageContext | null = null;
    provider.onMessage(async ctx => {
      receivedContext = ctx;
    });
    await provider.start();

    await messageCallback!({
      chat: { id: 12345, type: 'private' },
      from: { id: 67890, first_name: 'TestUser', is_bot: false },
      message: { message_id: 42, text: 'hello', date: 1000, from: { id: 67890, first_name: 'TestUser' }, entities: [] },
      date: 1000,
    });

    await receivedContext!.reply('the answer that must survive');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe('the answer that must survive');
    expect((sent[0]?.options as { reply_parameters?: unknown } | undefined)?.reply_parameters).toBeUndefined();
    await provider.stop();
  });

  /**
   * `editMessage` split the text with `String.slice`, which cuts a surrogate pair
   * when an astral character straddles the limit: both halves rendered as U+FFFD.
   */
  test('editMessage splits long text on code points', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    let messageCallback: ((ctx: unknown) => Promise<void>) | undefined;
    const edits: string[] = [];
    const continuations: string[] = [];
    telegramProviderDeps.createBot = () => ({
      on: (event: string, handler: (ctx: unknown) => Promise<void>) => {
        if (event === 'message') messageCallback = handler;
      },
      api: {
        sendMessage: async (_chatId: string, text: string) => {
          continuations.push(text);
          return { message_id: 900 + continuations.length };
        },
        editMessageText: async (_chatId: number, _messageId: number, text: string) => {
          edits.push(text);
          return true;
        },
      } as never,
      stop: () => undefined,
      start: async (options?: { onStart?: (info: { id: number; username: string }) => Promise<void> }) => {
        await options?.onStart?.({ id: 777, username: 'elastrax_bot' });
      },
    }) as never;

    const provider = new TelegramProvider();
    let receivedContext: MessageContext | null = null;
    provider.onMessage(async ctx => {
      receivedContext = ctx;
    });
    await provider.start();

    await messageCallback!({
      chat: { id: 12345, type: 'private' },
      from: { id: 67890, first_name: 'TestUser', is_bot: false },
      message: { message_id: 42, text: 'hello', date: 1000, from: { id: 67890, first_name: 'TestUser' }, entities: [] },
      date: 1000,
    });

    // The emoji sits exactly across the limit, where a UTF-16 slice would cut it.
    const sentKey = await receivedContext!.sendMessage!('placeholder');
    continuations.length = 0;
    const longText = `${'a'.repeat(TELEGRAM_TEXT_LIMIT - 1)}😀 b`;
    await receivedContext!.editMessage!(sentKey, longText);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.endsWith('😀')).toBe(true);
    expect(edits[0]!.includes('\uFFFD')).toBe(false);
    expect(continuations).toHaveLength(1);
    expect(continuations[0]!.startsWith('\u2026 ')).toBe(true);
    expect(`${edits[0]}${continuations[0]!.replace(/^\u2026 /, '')}`).toBe(longText);
    await provider.stop();
  });
});

afterAll(() => {
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalOwnerJid === undefined) delete process.env.BOT_OWNER_JID;
  else process.env.BOT_OWNER_JID = originalOwnerJid;
  if (originalOwnerTelegram === undefined) delete process.env.BOT_OWNER_TELEGRAM_ID;
  else process.env.BOT_OWNER_TELEGRAM_ID = originalOwnerTelegram;
  if (originalOwnerDiscord === undefined) delete process.env.BOT_OWNER_DISCORD_ID;
  else process.env.BOT_OWNER_DISCORD_ID = originalOwnerDiscord;
});
