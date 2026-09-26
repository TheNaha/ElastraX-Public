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
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

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
