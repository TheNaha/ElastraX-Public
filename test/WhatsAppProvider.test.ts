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

import { IdentityService } from '../src/utils/IdentityService';
import { AuthService as RoleService } from '../src/utils/AuthService';

const mockIdentityUpsert = mock(async () => {});
const mockSetRole = mock(async () => {});

mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));
import { WhatsAppProvider, whatsAppProviderDeps } from '../src/providers/whatsapp';

type FakeWhatsAppListener = (payload: unknown) => unknown;
type WhatsAppSocketInstance = ReturnType<typeof whatsAppProviderDeps.createSocket>;
type WhatsAppAuthStateResult = Awaited<ReturnType<typeof whatsAppProviderDeps.useAuthState>>;

type FakeWhatsAppSocket = {
  user: { id: string };
  end: ReturnType<typeof mock>;
  sendMessage: ReturnType<typeof mock>;
  readMessages: ReturnType<typeof mock>;
  updateMediaMessage: ReturnType<typeof mock>;
  groupParticipantsUpdate: ReturnType<typeof mock>;
  groupInviteCode: ReturnType<typeof mock>;
  groupSettingUpdate: ReturnType<typeof mock>;
  groupLeave: ReturnType<typeof mock>;
  sendPresenceUpdate: ReturnType<typeof mock>;
  signalRepository: {
    lidMapping: {
      getLIDForPN: ReturnType<typeof mock>;
    };
  };
  ev: {
    on: ReturnType<typeof mock>;
  };
};

function createFakeSocket() {
  const listeners = new Map<string, FakeWhatsAppListener>();

  const sock: FakeWhatsAppSocket = {
    user: { id: '628111:0@s.whatsapp.net' },
    end: mock(() => {}),
    sendMessage: mock(async (_jid: string, _content: unknown, _options?: unknown) => ({ key: { id: 'sent-1' } })),
    readMessages: mock(async () => {}),
    updateMediaMessage: mock(async () => {}),
    groupParticipantsUpdate: mock(async () => {}),
    groupInviteCode: mock(async () => 'invite-code'),
    groupSettingUpdate: mock(async () => {}),
    groupLeave: mock(async () => {}),
    sendPresenceUpdate: mock(async () => {}),
    signalRepository: {
      lidMapping: {
        getLIDForPN: mock(async (jid: string) => {
          if (jid === '628111@s.whatsapp.net') return 'bot@lid';
          if (jid === 'owner@s.whatsapp.net') return 'owner@lid';
          return null;
        }),
      },
    },
    ev: {
      on: mock((event: string, handler: FakeWhatsAppListener) => {
        listeners.set(event, handler);
      }),
    },
  };

  return {
    sock,
    emit: async (event: string, payload: unknown) => {
      const handler = listeners.get(event);
      if (handler) {
        await handler(payload);
      }
    },
  };
}

function createFakeAuthState(): WhatsAppAuthStateResult {
  return {
    state: {
      creds: {},
      keys: {},
    } as unknown as WhatsAppAuthStateResult['state'],
    saveCreds: mock(async () => {}),
  };
}

function asWhatsAppSocket(sock: FakeWhatsAppSocket): WhatsAppSocketInstance {
  return sock as unknown as WhatsAppSocketInstance;
}

describe('WhatsAppProvider', () => {
  const originalUseAuthState = whatsAppProviderDeps.useAuthState;
  const originalFetchLatestVersion = whatsAppProviderDeps.fetchLatestVersion;
  const originalCreateSocket = whatsAppProviderDeps.createSocket;
  const originalRenderQr = whatsAppProviderDeps.renderQr;
  const originalLookupStoredMessage = whatsAppProviderDeps.lookupStoredMessage;

  let identitySpy: ReturnType<typeof spyOn>;
  let roleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    delete process.env.BOT_OWNER_JID;
    mockIdentityUpsert.mockClear();
    mockSetRole.mockClear();
    identitySpy = spyOn(IdentityService, 'upsertIdentity').mockImplementation(mockIdentityUpsert);
    roleSpy = spyOn(RoleService, 'setRole').mockImplementation(mockSetRole);
  });

  afterEach(() => {
    identitySpy?.mockRestore();
    roleSpy?.mockRestore();
    whatsAppProviderDeps.useAuthState = originalUseAuthState;
    whatsAppProviderDeps.fetchLatestVersion = originalFetchLatestVersion;
    whatsAppProviderDeps.createSocket = originalCreateSocket;
    whatsAppProviderDeps.renderQr = originalRenderQr;
    whatsAppProviderDeps.lookupStoredMessage = originalLookupStoredMessage;
    delete process.env.BOT_OWNER_JID;
  });

  test('renders QR codes from connection updates', async () => {
    const { sock, emit } = createFakeSocket();
    const renderQr = mock(() => {});

    whatsAppProviderDeps.useAuthState = async () => createFakeAuthState();
    whatsAppProviderDeps.fetchLatestVersion = async () => ({ version: [1, 2, 3], isLatest: true });
    whatsAppProviderDeps.createSocket = () => asWhatsAppSocket(sock);
    whatsAppProviderDeps.renderQr = renderQr;

    const provider = new WhatsAppProvider();
    await provider.start();
    await emit('connection.update', { qr: 'qr-payload' });

    expect(renderQr).toHaveBeenCalledWith('qr-payload');
  });

  test('seeds owner identity and role on open', async () => {
    const { sock, emit } = createFakeSocket();

    process.env.BOT_OWNER_JID = 'owner@s.whatsapp.net';
    whatsAppProviderDeps.useAuthState = async () => createFakeAuthState();
    whatsAppProviderDeps.fetchLatestVersion = async () => ({ version: [1, 2, 3], isLatest: true });
    whatsAppProviderDeps.createSocket = () => asWhatsAppSocket(sock);
    whatsAppProviderDeps.renderQr = mock(() => {});

    const provider = new WhatsAppProvider();
    await provider.start();
    await emit('connection.update', { connection: 'open' });

    expect(mockIdentityUpsert).toHaveBeenCalledWith('owner@lid', 'owner@s.whatsapp.net', undefined, 'whatsapp');
    expect(mockSetRole).toHaveBeenCalledWith('owner@lid', 'owner', 'global', 'whatsapp', 'system:startup');
  });

  test('marks inbound notify messages as read and forwards parsed contexts', async () => {
    const { sock, emit } = createFakeSocket();

    whatsAppProviderDeps.useAuthState = async () => createFakeAuthState();
    whatsAppProviderDeps.fetchLatestVersion = async () => ({ version: [1, 2, 3], isLatest: true });
    whatsAppProviderDeps.createSocket = () => asWhatsAppSocket(sock);
    whatsAppProviderDeps.renderQr = mock(() => {});

    const provider = new WhatsAppProvider();
    const handler = mock(async () => {});
  const ctx = { platform: 'whatsapp', chatId: 'chat-1' } as Pick<MessageContext, 'platform' | 'chatId'>;
  const createContextSpy = spyOn(provider as unknown as { createContext: (message: unknown) => Promise<unknown> }, 'createContext').mockResolvedValue(ctx);

    provider.onMessage(handler);
    await provider.start();
    await emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { id: 'msg-1', remoteJid: 'chat-1', fromMe: false },
          message: { conversation: 'hello' },
        },
      ],
    });

    expect(sock.readMessages).toHaveBeenCalledTimes(1);
    expect(createContextSpy).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(ctx);

    createContextSpy.mockRestore();
  });

  test('schedules reconnect on close and clears it on stop', async () => {
    const { sock, emit } = createFakeSocket();

    whatsAppProviderDeps.useAuthState = async () => createFakeAuthState();
    whatsAppProviderDeps.fetchLatestVersion = async () => ({ version: [1, 2, 3], isLatest: true });
    whatsAppProviderDeps.createSocket = () => asWhatsAppSocket(sock);
    whatsAppProviderDeps.renderQr = mock(() => {});

    const provider = new WhatsAppProvider();
    await provider.start();
    await emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });

    expect((provider as unknown as { reconnectTimer: unknown }).reconnectTimer).not.toBeNull();

    await provider.stop();

    expect((provider as unknown as { reconnectTimer: unknown }).reconnectTimer).toBeNull();
  });

  test('stop ends an active socket session', async () => {
    const { sock } = createFakeSocket();

    whatsAppProviderDeps.useAuthState = async () => createFakeAuthState();
    whatsAppProviderDeps.fetchLatestVersion = async () => ({ version: [1, 2, 3], isLatest: true });
    whatsAppProviderDeps.createSocket = () => asWhatsAppSocket(sock);
    whatsAppProviderDeps.renderQr = mock(() => {});

    const provider = new WhatsAppProvider();
    await provider.start();
    await provider.stop();

    expect(sock.end).toHaveBeenCalled();
    expect((provider as unknown as { sock: unknown }).sock).toBeNull();
  });

  test('getMessage returns only a message body and undefined for missing rows', async () => {
    const { sock } = createFakeSocket();
    let socketOptions: Parameters<typeof whatsAppProviderDeps.createSocket>[0] | undefined;
    whatsAppProviderDeps.useAuthState = async () => createFakeAuthState();
    whatsAppProviderDeps.fetchLatestVersion = async () => ({ version: [1, 2, 3], isLatest: true });
    whatsAppProviderDeps.createSocket = options => {
      socketOptions = options;
      return asWhatsAppSocket(sock);
    };
    whatsAppProviderDeps.renderQr = mock(() => {});
    whatsAppProviderDeps.lookupStoredMessage = async id => id === 'full'
      ? JSON.stringify({ key: { id }, message: { conversation: 'retry me' } })
      : id === 'body' ? JSON.stringify({ conversation: 'body only' }) : null;

    const provider = new WhatsAppProvider();
    await provider.start();
    const getMessage = socketOptions!.getMessage!;
    await expect(getMessage({ id: 'full' } as never)).resolves.toEqual({ conversation: 'retry me' });
    await expect(getMessage({ id: 'body' } as never)).resolves.toEqual({ conversation: 'body only' });
    await expect(getMessage({ id: 'missing' } as never)).resolves.toBeUndefined();
    await provider.stop();
    await expect(getMessage({ id: 'full' } as never)).resolves.toBeUndefined();
  });

  test('stopping during async auth prevents socket creation', async () => {
    let resolveAuth!: (value: WhatsAppAuthStateResult) => void;
    whatsAppProviderDeps.useAuthState = () => new Promise<WhatsAppAuthStateResult>(resolve => { resolveAuth = resolve; });
    whatsAppProviderDeps.fetchLatestVersion = async () => ({ version: [1, 2, 3], isLatest: true });
    const createSocket = mock(() => { throw new Error('must not create'); });
    whatsAppProviderDeps.createSocket = createSocket as never;
    const provider = new WhatsAppProvider();

    const starting = provider.start();
    await provider.stop();
    resolveAuth(createFakeAuthState());
    await starting;

    expect(createSocket).not.toHaveBeenCalled();
    expect(provider.status).toBe('stopped');
  });

  test('sends audio with WhatsApp voice-note parity', async () => {
    const { sock } = createFakeSocket();
    whatsAppProviderDeps.useAuthState = async () => createFakeAuthState();
    whatsAppProviderDeps.fetchLatestVersion = async () => ({ version: [1, 2, 3], isLatest: true });
    whatsAppProviderDeps.createSocket = () => asWhatsAppSocket(sock);
    const provider = new WhatsAppProvider();
    await provider.start();
    const ctx = await (provider as unknown as { createContext(message: unknown): Promise<MessageContext> }).createContext({
      key: { id: 'msg-audio', remoteJid: 'chat-1', fromMe: false },
      message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, fileLength: '4' } },
      pushName: 'Alice',
    });
    const audio = Buffer.from('audio');

    await ctx.sendMedia?.(audio, { mimetype: 'audio/ogg', ptt: true });

    expect(sock.sendMessage.mock.calls[0]![0]).toBe('chat-1');
    expect(sock.sendMessage.mock.calls[0]![1]).toEqual({ audio, mimetype: 'audio/ogg', ptt: true });
    expect(sock.sendMessage.mock.calls[0]![2]).toMatchObject({ quoted: expect.anything() });
    await provider.stop();
  });

  test('routes audio, video, image, and document media to the matching WhatsApp field', async () => {
    const { sock } = createFakeSocket();
    whatsAppProviderDeps.useAuthState = async () => createFakeAuthState();
    whatsAppProviderDeps.fetchLatestVersion = async () => ({ version: [1, 2, 3], isLatest: true });
    whatsAppProviderDeps.createSocket = () => asWhatsAppSocket(sock);
    const provider = new WhatsAppProvider();
    await provider.start();
    const ctx = await (provider as unknown as { createContext(message: unknown): Promise<MessageContext> }).createContext({
      key: { id: 'msg-media', remoteJid: 'chat-1', fromMe: false },
      message: { conversation: 'hi' },
      pushName: 'Alice',
    });
    const buffer = Buffer.from('payload');

    await ctx.sendMedia?.(buffer, { mimetype: 'audio/ogg' });
    await ctx.sendMedia?.(buffer, { mimetype: 'video/mp4', caption: 'clip' });
    await ctx.sendMedia?.(buffer, { mimetype: 'image/png', caption: 'pic' });
    await ctx.sendMedia?.(buffer, { mimetype: 'application/pdf', filename: 'doc.pdf', caption: 'read' });

    expect(sock.sendMessage.mock.calls[0]![1]).toEqual({ audio: buffer, mimetype: 'audio/ogg', ptt: false });
    expect(sock.sendMessage.mock.calls[1]![1]).toEqual({ video: buffer, caption: 'clip', mimetype: 'video/mp4' });
    expect(sock.sendMessage.mock.calls[2]![1]).toEqual({ image: buffer, caption: 'pic', mimetype: 'image/png' });
    expect(sock.sendMessage.mock.calls[3]![1]).toEqual({
      document: buffer,
      mimetype: 'application/pdf',
      fileName: 'doc.pdf',
      caption: 'read',
    });
    await provider.stop();
  });

  test('falls back to a generic document name when no filename is supplied', async () => {
    const { sock } = createFakeSocket();
    whatsAppProviderDeps.useAuthState = async () => createFakeAuthState();
    whatsAppProviderDeps.fetchLatestVersion = async () => ({ version: [1, 2, 3], isLatest: true });
    whatsAppProviderDeps.createSocket = () => asWhatsAppSocket(sock);
    const provider = new WhatsAppProvider();
    await provider.start();
    const ctx = await (provider as unknown as { createContext(message: unknown): Promise<MessageContext> }).createContext({
      key: { id: 'msg-doc', remoteJid: 'chat-1', fromMe: false },
      message: { conversation: 'hi' },
      pushName: 'Alice',
    });

    await ctx.sendMedia?.(Buffer.from('payload'), { mimetype: 'application/pdf' });

    expect(sock.sendMessage.mock.calls[0]![1]).toMatchObject({ fileName: 'file', caption: undefined });
    await provider.stop();
  });

  test('propagates delete and reaction failures', async () => {
    const { sock } = createFakeSocket();
    sock.sendMessage = mock(async () => { throw new Error('provider action failed'); });
    whatsAppProviderDeps.useAuthState = async () => createFakeAuthState();
    whatsAppProviderDeps.fetchLatestVersion = async () => ({ version: [1, 2, 3], isLatest: true });
    whatsAppProviderDeps.createSocket = () => asWhatsAppSocket(sock);
    const provider = new WhatsAppProvider();
    await provider.start();
    const ctx = await (provider as unknown as { createContext(message: unknown): Promise<MessageContext> }).createContext({
      key: { id: 'msg-fail', remoteJid: 'chat-1', fromMe: false },
      message: { conversation: 'hello' },
      pushName: 'Alice',
    });

    await expect(ctx.react?.('✅')).rejects.toThrow('provider action failed');
    await expect(ctx.deleteMessage?.()).rejects.toThrow('provider action failed');
    await provider.stop();
  });

  test('surfaces startup failure while retaining bounded reconnect', async () => {
    whatsAppProviderDeps.useAuthState = async () => createFakeAuthState();
    whatsAppProviderDeps.fetchLatestVersion = async () => { throw new Error('version lookup failed'); };
    const provider = new WhatsAppProvider();

    await expect(provider.start()).rejects.toThrow('WhatsApp startup failed');
    expect(provider.status).toBe('backoff');
    expect((provider as unknown as { reconnectTimer: unknown }).reconnectTimer).not.toBeNull();
    await provider.stop();
  });
});
