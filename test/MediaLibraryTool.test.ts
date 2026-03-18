import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { MessageContext } from '../src/core/MessageContext';
import { MediaLibraryTool, mediaLibraryToolDeps } from '../src/tools/MediaLibraryTool';

const originalCreateJellyfinClient = mediaLibraryToolDeps.createJellyfinClient;
const originalBindingService = mediaLibraryToolDeps.bindingService;

const createMockCtx = (): MessageContext => ({
  platform: 'discord',
  chatId: 'room-1',
  senderId: 'user-1',
  senderName: 'Alice',
  text: '',
  messageType: 'conversation',
  isGroup: false,
  isBotMentioned: false,
  hasMedia: false,
  mediaReady: Promise.resolve(),
  rawMessage: {},
  reply: mock(async () => {}),
  checkPermissions: mock(async () => true),
  resolveRoles: mock(async () => ['user']),
});

describe('MediaLibraryTool', () => {
  afterEach(() => {
    mediaLibraryToolDeps.createJellyfinClient = originalCreateJellyfinClient;
    mediaLibraryToolDeps.bindingService = originalBindingService;
  });

  test('returns a configuration message when Jellyfin is unavailable', async () => {
    mediaLibraryToolDeps.createJellyfinClient = () => ({ isConfigured: false }) as any;

    const result = await new MediaLibraryTool().execute({ action: 'search', query: 'matrix' }, createMockCtx());
    expect(result).toContain('not configured');
  });

  test('search returns formatted library results', async () => {
    mediaLibraryToolDeps.bindingService = {
      getBinding: mock(async () => ({ externalUserId: 'user-jf' })),
    } as any;
    mediaLibraryToolDeps.createJellyfinClient = () => ({
      isConfigured: true,
      searchItems: mock(async () => ({
        Items: [{ Id: 'item-1', Name: 'The Matrix', Type: 'Movie', ProductionYear: 1999 }],
        TotalRecordCount: 1,
      })),
      getWatchLink: mock((id: string) => `https://watch.example/${id}`),
    }) as any;

    const result = await new MediaLibraryTool().execute({ action: 'search', query: 'matrix' }, createMockCtx());
    expect(result).toContain('The Matrix');
    expect(result).toContain('https://watch.example/item-1');
  });

  test('latest returns recent additions', async () => {
    mediaLibraryToolDeps.bindingService = {
      getBinding: mock(async () => ({ externalUserId: 'user-jf' })),
    } as any;
    mediaLibraryToolDeps.createJellyfinClient = () => ({
      isConfigured: true,
      getLatestMedia: mock(async () => [
        { Id: 'item-2', Name: 'Silo', Type: 'Series', ProductionYear: 2025 },
      ]),
      getWatchLink: mock((id: string) => `https://watch.example/${id}`),
    }) as any;

    const result = await new MediaLibraryTool().execute({ action: 'latest' }, createMockCtx());
    expect(result).toContain('Recently Added');
    expect(result).toContain('Silo');
  });

  test('link and info actions return direct watch details', async () => {
    mediaLibraryToolDeps.bindingService = {
      getBinding: mock(async () => ({ externalUserId: 'user-jf' })),
    } as any;
    mediaLibraryToolDeps.createJellyfinClient = () => ({
      isConfigured: true,
      getWatchLink: mock((id: string) => `https://watch.example/${id}`),
      getItem: mock(async () => ({
        Id: 'item-3',
        Name: 'The Expanse',
        Type: 'Series',
        Genres: ['Sci-Fi'],
        RunTimeTicks: 1_200_000_000,
        ProductionYear: 2015,
        Overview: 'Space politics.',
      })),
    }) as any;

    const tool = new MediaLibraryTool();
    const linkResult = await tool.execute({ action: 'link', item_id: 'item-3' }, createMockCtx());
    const infoResult = await tool.execute({ action: 'info', item_id: 'item-3' }, createMockCtx());

    expect(linkResult).toContain('https://watch.example/item-3');
    expect(infoResult).toContain('The Expanse');
    expect(infoResult).toContain('Space politics.');
  });
});
