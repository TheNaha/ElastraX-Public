import { expect, test, describe, mock } from 'bun:test';
import { GroupAdminTool } from '../src/tools/GroupAdminTool';
import { MessageContext } from '../src/core/MessageContext';

describe('GroupAdminTool', () => {
  test('should have basic properties', () => {
    const tool = new GroupAdminTool();
    expect(tool.name).toBe('groupadmin');
    expect(tool.description).toBeString();
    expect(tool.aliases).toContain('kick');
    expect(tool.aliases).toContain('add');
    expect(tool.category).toBe('admin');
    expect(tool.permissions).toBe('admin');
  });

  test('definition should match OpenAI schema', () => {
    const tool = new GroupAdminTool();
    const def = tool.definition;

    expect(def.type).toBe('function');
    expect(def.function.name).toBe('groupadmin');
    expect(def.function.parameters.required).toContain('action');
    expect(def.function.parameters.required).toContain('user');
  });

  describe('execute', () => {
    const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => {
      return {
        platform: 'whatsapp',
        chatId: 'group-id',
        senderId: 'user-id',
        senderName: 'User',
        text: '',
        isGroup: true,
        isBotMentioned: false,
        hasMedia: false,
        reply: mock(async () => {}),
        react: mock(async () => {}),
        updateGroupParticipants: mock(async () => {}),
        rawMessage: {},
        ...overrides,
      } as MessageContext;
    };

    test('should fail if not in a group', async () => {
      const tool = new GroupAdminTool();
      const ctx = createMockCtx({ isGroup: false });
      const result = await tool.execute({ action: 'add', user: '628123456789' }, ctx);
      expect(result).toBe("❌ This command can only be used in a group.");
    });

    test('should fail if action is invalid', async () => {
      const tool = new GroupAdminTool();
      const ctx = createMockCtx();
      const result = await tool.execute({ action: 'invalid', user: '628123456789' }, ctx);
      expect(result).toBe("❌ Invalid action. Must be 'add' or 'remove'.");
    });

    test('should fail if user phone number is invalid', async () => {
      const tool = new GroupAdminTool();
      const ctx = createMockCtx();
      const result = await tool.execute({ action: 'add', user: 'abc' }, ctx);
      expect(result).toBe("❌ Invalid user phone number.");
    });

    test('should fail if updateGroupParticipants is not supported', async () => {
      const tool = new GroupAdminTool();
      const ctx = createMockCtx({ updateGroupParticipants: undefined });
      const result = await tool.execute({ action: 'add', user: '628123456789' }, ctx);
      expect(result).toBe("❌ Group Administration is not supported by the current adapter.");
    });

    test('should succeed for add action with 0 prefix', async () => {
      const tool = new GroupAdminTool();
      const ctx = createMockCtx();
      const result = await tool.execute({ action: 'add', user: '08123456789' }, ctx);

      expect(ctx.react).toHaveBeenCalledWith('⏳');
      expect(ctx.updateGroupParticipants).toHaveBeenCalledWith('add', ['628123456789@s.whatsapp.net']);
      expect(result).toContain('✅ Successfully Added user 628123456789@s.whatsapp.net.');
    });

    test('should succeed for remove action', async () => {
      const tool = new GroupAdminTool();
      const ctx = createMockCtx();
      const result = await tool.execute({ action: 'remove', user: '628123456789' }, ctx);

      expect(ctx.react).toHaveBeenCalledWith('⏳');
      expect(ctx.updateGroupParticipants).toHaveBeenCalledWith('remove', ['628123456789@s.whatsapp.net']);
      expect(result).toContain('✅ Successfully Removed user 628123456789@s.whatsapp.net.');
    });

    test('should handle errors from updateGroupParticipants', async () => {
      const tool = new GroupAdminTool();
      const error = new Error('Failed to update');
      const ctx = createMockCtx({
        updateGroupParticipants: mock(async () => { throw error; })
      });

      const result = await tool.execute({ action: 'add', user: '628123456789' }, ctx);
      expect(result).toContain('❌ Error administering group: Failed to update.');
    });
  });
});
