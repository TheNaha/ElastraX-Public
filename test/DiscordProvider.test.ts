import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { MessageContext } from '../src/core/MessageContext';

const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};

mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

import { DiscordProvider, discordProviderDeps } from '../src/providers/discord';

type FakeDiscordListener = (...args: unknown[]) => unknown;
type DiscordClientInstance = ReturnType<typeof discordProviderDeps.createClient>;

type FakeDiscordClient = {
  user: { id: string; tag: string };
  login: ReturnType<typeof mock>;
  destroy: ReturnType<typeof mock>;
  channels: {
    fetch: ReturnType<typeof mock>;
  };
  on: ReturnType<typeof mock>;
  emit(event: string, ...args: unknown[]): Promise<void>;
};

function createFakeClient() {
  const listeners = new Map<string, FakeDiscordListener>();

  const client: FakeDiscordClient = {
    user: { id: 'bot-1', tag: 'bot#0001' },
    login: mock(async () => {}),
    destroy: mock(() => {}),
    channels: {
      fetch: mock(async () => null),
    },
    on: mock((event: string, handler: FakeDiscordListener) => {
      listeners.set(event, handler);
      return client;
    }),
    emit: async (event: string, ...args: unknown[]) => {
      const handler = listeners.get(event);
      if (handler) {
        await handler(...args);
      }
    },
  };

  return client;
}

function asDiscordClient(client: FakeDiscordClient): DiscordClientInstance {
  return client as unknown as DiscordClientInstance;
}

describe('DiscordProvider', () => {
  const originalCreateClient = discordProviderDeps.createClient;

  beforeEach(() => {
    process.env.DISCORD_BOT_TOKEN = 'discord-test-token';
  });

  afterEach(() => {
    discordProviderDeps.createClient = originalCreateClient;
    delete process.env.DISCORD_BOT_TOKEN;
  });

  test('skips startup when token is missing', async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    const createClient = mock(() => createFakeClient());
    discordProviderDeps.createClient = createClient as unknown as typeof discordProviderDeps.createClient;

    const provider = new DiscordProvider();
    await provider.start();

    expect(createClient).not.toHaveBeenCalled();
    expect((provider as unknown as { client: unknown }).client).toBeNull();
  });

  test('logs in and forwards non-bot messages to the registered handler', async () => {
    const client = createFakeClient();
    discordProviderDeps.createClient = () => asDiscordClient(client);

    const provider = new DiscordProvider();
    const handler = mock(async () => {});
  const ctx = { platform: 'discord', chatId: 'chan-1' } as Pick<MessageContext, 'platform' | 'chatId'>;
  const createContextSpy = spyOn(provider as unknown as { createContext: (message: unknown) => Promise<unknown> }, 'createContext').mockResolvedValue(ctx);

    provider.onMessage(handler);
    await provider.start();
    await client.emit('messageCreate', { author: { bot: false } });
    await client.emit('messageCreate', { author: { bot: true } });

    expect(client.login).toHaveBeenCalledWith('discord-test-token');
    expect(createContextSpy).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(ctx);

    createContextSpy.mockRestore();
  });

  test('sendMessage sends text to a fetched text channel', async () => {
    const send = mock(async () => {});
    const client = createFakeClient();
    client.channels.fetch = mock(async () => ({
      isTextBased: () => true,
      send,
    }));
    discordProviderDeps.createClient = () => asDiscordClient(client);

    const provider = new DiscordProvider();
    await provider.start();
    await provider.sendMessage('channel-123', 'hello from test');

    expect(client.channels.fetch).toHaveBeenCalledWith('channel-123');
    expect(send).toHaveBeenCalledWith('hello from test');
  });

  test('stop destroys the client and clears the live reference', async () => {
    const client = createFakeClient();
    discordProviderDeps.createClient = () => asDiscordClient(client);

    const provider = new DiscordProvider();
    await provider.start();
    await provider.stop();

    expect(client.destroy).toHaveBeenCalled();
    await expect(provider.sendMessage('channel-123', 'hello')).rejects.toThrow('Discord client is not initialized.');
  });

  test('forwardMessage sends the current message content when no custom text is provided', async () => {
    const send = mock(async () => {});
    const client = createFakeClient();
    client.channels.fetch = mock(async () => ({
      isTextBased: () => true,
      send,
    }));

    const provider = new DiscordProvider();
    (provider as unknown as { client: unknown }).client = asDiscordClient(client);

    const mentions = new Map<string, { id: string }>();
    const attachments = new Map<string, { url: string; size: number }>() as Map<string, { url: string; size: number }> & { first(): undefined };
    attachments.first = () => undefined;

    const ctx = await (provider as unknown as {
      createContext(message: unknown): Promise<MessageContext>;
    }).createContext({
      id: 'msg-1',
      author: { id: 'user-1', username: 'alice', bot: false },
      channelId: 'source-1',
      content: 'hello world',
      attachments,
      mentions: { users: mentions },
      reference: null,
      channel: {
        isDMBased: () => false,
        messages: { fetch: mock(async () => null) },
      },
      guild: null,
      reply: mock(async () => ({})),
      react: mock(async () => {}),
      delete: mock(async () => {}),
    });

    await ctx.forwardMessage?.('target-1');

    expect(send).toHaveBeenCalledWith({ content: 'hello world' });
  });
});
