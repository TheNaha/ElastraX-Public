import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';

const _mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => _mockLogger, trace: () => {} };
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

let mockRoomRows: any[] = [];

mock.module('../src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          all: () => mockRoomRows,
        }),
        all: () => mockRoomRows,
      }),
    }),
  },
}));

import { OwnerTool } from '../src/tools/OwnerTool';

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'user-1',
  senderName: 'User',
  text: '',
  isGroup: false,
  hasMedia: false,
  language: 'en',
  messageType: 'conversation',
  messageId: 'msg-1',
  mediaReady: Promise.resolve(),
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  resolveRoles: mock(async () => ['owner']),
  rawMessage: {},
  ...overrides,
} as MessageContext);

beforeEach(() => {
  mockRoomRows = [];
});

describe('OwnerTool', () => {
  const tool = new OwnerTool();

  test('basic properties', () => {
    expect(tool.name).toBe('owner_admin');
    expect(tool.aliases).toContain('owner');
    expect(tool.aliases).toContain('broadcast');
    expect(tool.aliases).toContain('leave');
    expect(tool.aliases).toContain('botleave');
    expect(tool.permissions).toBe('owner');
  });

  test('action=broadcast without message returns broadcast_no_message', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'broadcast' }, ctx);
    expect(result).toContain('broadcast message');
  });

  test('action=broadcast with no rooms returns broadcast_no_rooms', async () => {
    mockRoomRows = [];
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'broadcast', message: 'Hello' }, ctx);
    expect(result).toContain('No rooms found');
  });

  test('action=broadcast with rooms sends to each via forwardMessage', async () => {
    mockRoomRows = [
      { id: 'room-2', platform: 'whatsapp' },
      { id: 'room-3', platform: 'whatsapp' },
    ];
    const mockForward = mock(async () => {});
    const ctx = createMockCtx({ forwardMessage: mockForward });
    const result = await tool.execute({ action: 'broadcast', message: 'Hello everyone' }, ctx);
    expect(result).toContain('Broadcast complete');
    expect(mockForward).toHaveBeenCalled();
  });

  test('action=leave when not in group returns leave_not_group', async () => {
    const ctx = createMockCtx({ isGroup: false });
    const result = await tool.execute({ action: 'leave' }, ctx);
    expect(result).toContain('only be used in a group');
  });

  test('action=leave in group calls leaveGroup', async () => {
    const mockLeave = mock(async () => {});
    const ctx = createMockCtx({ isGroup: true, leaveGroup: mockLeave });
    const result = await tool.execute({ action: 'leave' }, ctx);
    expect(mockLeave).toHaveBeenCalled();
    expect(result).toBe('');
  });

  test('action=leave without leaveGroup returns leave_not_supported', async () => {
    const ctx = createMockCtx({ isGroup: true });
    // Ensure leaveGroup is not set
    delete (ctx as any).leaveGroup;
    const result = await tool.execute({ action: 'leave' }, ctx);
    expect(result).toContain('not supported');
  });

  test('action=system_info returns system info text', async () => {
    mockRoomRows = [{ id: 'room-1' }];
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'system_info' }, ctx);
    expect(result).toContain('System Info');
    expect(result).toContain('Uptime');
    expect(result).toContain('Memory');
  });

  test('unknown action returns owner.usage', async () => {
    const ctx = createMockCtx();
    const result = await tool.execute({ action: 'unknown_action' }, ctx);
    expect(result).toContain('Owner Commands');
  });
});
