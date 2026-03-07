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

const mockIdentityUpsert = mock(async () => {});
const mockSetRole = mock(async () => {});

mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));
mock.module('../src/utils/IdentityService', () => ({
  IdentityService: { upsert: mockIdentityUpsert },
}));
mock.module('../src/utils/RoleService', () => ({
  RoleService: { setRole: mockSetRole },
}));
mock.module('../src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  },
}));

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
    sendMessage: mock(async () => ({ key: { id: 'sent-1' } })),
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

  beforeEach(() => {
    delete process.env.BOT_OWNER_JID;
    mockIdentityUpsert.mockClear();
    mockSetRole.mockClear();
  });

  afterEach(() => {
    whatsAppProviderDeps.useAuthState = originalUseAuthState;
    whatsAppProviderDeps.fetchLatestVersion = originalFetchLatestVersion;
    whatsAppProviderDeps.createSocket = originalCreateSocket;
    whatsAppProviderDeps.renderQr = originalRenderQr;
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
});