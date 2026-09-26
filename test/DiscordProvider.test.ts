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

import { DiscordProvider, chunkDiscordText, discordProviderDeps } from '../src/providers/discord';
import { mediaStorageDeps } from '../src/utils/MediaStorage';

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
    // Real discord.js emits `clientReady` once the gateway sends READY, which is
    // strictly after `login()` resolves. The provider only marks itself
    // operational on that event, so the double has to model it.
    login: mock(async () => {
      await client.emit('clientReady');
    }),
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
  const originalFetch = discordProviderDeps.fetch;
  const originalMediaStorage = { ...mediaStorageDeps };

  beforeEach(() => {
    process.env.DISCORD_BOT_TOKEN = 'discord-test-token';
  });

  afterEach(() => {
    discordProviderDeps.createClient = originalCreateClient;
    discordProviderDeps.fetch = originalFetch;
    Object.assign(mediaStorageDeps, originalMediaStorage);
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
    expect(provider.status).toBe('not_configured');
    expect(provider.isOperational).toBe(false);
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
    expect(send).toHaveBeenCalledWith({ content: 'hello from test', allowedMentions: { parse: [] } });
  });

  test('stop destroys the client and clears the live reference', async () => {
    const client = createFakeClient();
    discordProviderDeps.createClient = () => asDiscordClient(client);

    const provider = new DiscordProvider();
    await provider.start();
    await provider.stop();

    expect(client.destroy).toHaveBeenCalled();
    await expect(provider.sendMessage('channel-123', 'hello')).rejects.toThrow('connection changed');
  });

  test('surfaces login failure as a provider start error', async () => {
    const client = createFakeClient();
    client.login = mock(async () => { throw new Error('invalid token'); });
    discordProviderDeps.createClient = () => asDiscordClient(client);
    const provider = new DiscordProvider();

    await expect(provider.start()).rejects.toThrow('Discord login failed');
    expect(client.destroy).toHaveBeenCalled();
    expect(provider.status).toBe('error');
    expect(provider.isOperational).toBe(false);
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

    expect(send).toHaveBeenCalledWith({ content: 'hello world', allowedMentions: { parse: [] } });
  });

  test('chunks Unicode text without splitting surrogate pairs', () => {
    const chunks = chunkDiscordText('😀'.repeat(2200), 2000);
    expect(chunks).toHaveLength(2);
    expect([...chunks[0]!].every(character => character === '😀')).toBe(true);
  });

  test('blocks implicit mentions while allowing explicitly requested users', async () => {
    const reply = mock(async (_payload: { content: string; allowedMentions: { parse: string[]; users: string[] } }) => ({}));
    const client = createFakeClient();
    const provider = new DiscordProvider();
    (provider as unknown as { client: unknown }).client = asDiscordClient(client);
    const ctx = await (provider as unknown as { createContext(message: unknown): Promise<MessageContext> }).createContext({
      id: 'msg-mention',
      author: { id: 'user-1', username: 'alice', bot: false },
      channelId: 'channel-1',
      content: '@everyone',
      attachments: new Map(),
      mentions: { users: new Map() },
      reference: null,
      channel: { isDMBased: () => true, messages: { fetch: mock(async () => null) } },
      guild: null,
      reply,
    });

    await ctx.reply?.('@everyone');
    await ctx.reply?.('hello <@123456789>', { mentions: ['123456789', '<@everyone>'] });

    expect(reply.mock.calls[0]![0]).toEqual({ content: '@everyone', allowedMentions: { parse: [], users: [] } });
    expect(reply.mock.calls[1]![0]).toEqual({ content: 'hello <@123456789>', allowedMentions: { parse: ['users'], users: ['123456789'] } });
  });

  test('describes every attachment lazily and selects the requested target', async () => {
    const fetchAttachment = mock(async (_url: string | URL | Request) => new Response('unused'));
    discordProviderDeps.fetch = fetchAttachment as unknown as typeof fetch;
    mediaStorageDeps.mkdir = mock(async () => {}) as never;
    mediaStorageDeps.chmod = mock(async () => {}) as never;
    mediaStorageDeps.readdir = mock(async () => []) as never;
    mediaStorageDeps.open = mock(async () => ({
      write: async (data: Uint8Array) => ({ bytesWritten: data.length }),
      sync: async () => undefined,
      close: async () => undefined,
    })) as never;
    mediaStorageDeps.rename = mock(async () => undefined) as never;
    mediaStorageDeps.rm = mock(async () => undefined) as never;
    const provider = new DiscordProvider();
    const client = createFakeClient();
    (provider as unknown as { client: unknown }).client = asDiscordClient(client);
    const attachments = new Map([
      ['a1', { id: 'a1', url: 'https://cdn.discordapp.com/attachments/a1', name: 'one.png', size: 10, contentType: 'image/png' }],
      ['a2', { id: 'a2', url: 'https://cdn.discordapp.com/attachments/a2', name: 'two.mp4', size: 20, contentType: 'video/mp4' }],
    ]);
    const ctx = await (provider as unknown as { createContext(message: unknown): Promise<MessageContext> }).createContext({
      id: 'msg-multi',
      author: { id: 'user-1', username: 'alice', bot: false },
      channelId: 'channel-1',
      content: '',
      attachments,
      mentions: { users: new Map() },
      reference: null,
      channel: { isDMBased: () => true, messages: { fetch: mock(async () => null) } },
      guild: null,
    });

    expect(ctx.mediaAttachments).toHaveLength(2);
    expect(ctx.mediaAttachments?.map(attachment => [attachment.index, attachment.filename, attachment.state])).toEqual([
      [0, 'one.png', 'pending'],
      [1, 'two.mp4', 'pending'],
    ]);
    expect(ctx.selectedAttachmentId).toBe(ctx.mediaAttachments?.[0]?.id);
    expect(fetchAttachment).not.toHaveBeenCalled();

    const second = ctx.mediaAttachments![1]!;
    const selected = await ctx.selectMediaAttachment!(second.id);
    expect(selected.state).toBe('ready');
    expect(ctx.selectedAttachmentId).toBe(second.id);
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    expect(fetchAttachment.mock.calls[0]![0]).toBe('https://cdn.discordapp.com/attachments/a2');
  });

  test('reports partial kick failures and supports playable audio filenames', async () => {
    const kick = mock(async (userId: string) => {
      if (userId === 'user-2') throw new Error('missing kick permission');
    });
    const reply = mock(async (_payload: { content?: string; allowedMentions?: unknown; files?: unknown[] }) => ({}));
    const client = createFakeClient();
    client.channels.fetch = mock(async () => ({ isTextBased: () => true, send: mock(async () => { throw new Error('forward failed'); }) }));
    (client as unknown as { guild: unknown }).guild = {};
    const provider = new DiscordProvider();
    (provider as unknown as { client: unknown }).client = asDiscordClient(client);
    const ctx = await (provider as unknown as { createContext(message: unknown): Promise<MessageContext> }).createContext({
      id: 'msg-group',
      author: { id: 'user-1', username: 'alice', bot: false },
      channelId: 'group-1',
      content: '',
      attachments: new Map(),
      mentions: { users: new Map() },
      reference: null,
      channel: { isDMBased: () => false, messages: { fetch: mock(async () => null) } },
      guild: { members: { kick } },
      reply,
    });

    await expect(ctx.updateGroupParticipants?.('remove', ['user-1', 'user-2'])).rejects.toThrow('Failed to kick 1 of 2');
    await expect(ctx.forwardMessage?.('target-1')).rejects.toThrow('forward failed');
    await ctx.sendMedia?.(Buffer.from('audio'), { mimetype: 'audio/ogg' });

    const mediaPayload = reply.mock.calls.at(-1)![0] as { files?: unknown[]; allowedMentions?: unknown; content?: string };
    expect(mediaPayload.files).toHaveLength(1);
    const attachment = mediaPayload.files![0] as { name?: string; description?: string };
    expect(attachment.name).toBe('attachment.ogg');
    expect(mediaPayload.allowedMentions).toEqual({ parse: [] });
  });

  test('includes a playable duration description for voice attachments', async () => {
    const reply = mock(async (_payload: unknown) => ({}));
    const provider = new DiscordProvider();
    (provider as unknown as { client: unknown }).client = asDiscordClient(createFakeClient());
    const ctx = await (provider as unknown as { createContext(message: unknown): Promise<MessageContext> }).createContext({
      id: 'msg-voice',
      author: { id: 'user-1', username: 'alice', bot: false },
      channelId: 'group-1',
      content: '',
      attachments: new Map(),
      mentions: { users: new Map() },
      reference: null,
      channel: { isDMBased: () => false, messages: { fetch: mock(async () => null) } },
      guild: { members: { kick: mock(async () => {}) } },
      reply,
    });

    await ctx.sendMedia?.(Buffer.from('audio'), { mimetype: 'audio/ogg', durationSeconds: 12.4 });

    const payload = reply.mock.calls.at(-1)![0] as { files?: Array<{ description?: string }> };
    expect(payload.files?.[0]?.description).toBe('Audio duration: 12 seconds');
  });

  test('propagates delete and reaction failures', async () => {
    const provider = new DiscordProvider();
    (provider as unknown as { client: unknown }).client = asDiscordClient(createFakeClient());
    const ctx = await (provider as unknown as { createContext(message: unknown): Promise<MessageContext> }).createContext({
      id: 'msg-fail',
      author: { id: 'user-1', username: 'alice', bot: false },
      channelId: 'channel-1',
      content: '',
      attachments: new Map(),
      mentions: { users: new Map() },
      reference: null,
      channel: { isDMBased: () => true, messages: { fetch: mock(async () => null) } },
      guild: null,
      delete: mock(async () => { throw new Error('missing permissions'); }),
      react: mock(async () => { throw new Error('reaction failed'); }),
    });

    await expect(ctx.deleteMessage?.()).rejects.toThrow('missing permissions');
    await expect(ctx.react?.('✅')).rejects.toThrow('reaction failed');
  });
});
