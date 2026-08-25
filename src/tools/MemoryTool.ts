import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { db } from '../db';
import { chatRooms, memories } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { ConfigService } from '../utils/ConfigService';

const log = logger.child({ module: 'MemoryTool' });

export class MemoryTool extends BaseTool {
  readonly name = 'memory';
  readonly description = 'Store, retrieve, or forget facts about the user to maintain long-term context across sessions. Only use if the user asks you to remember or forget something.';
  readonly aliases = ['mem', 'remember', 'forget'];
  readonly category = 'utility';
  readonly permissions = 'user';

  override readonly triggerPatterns = [
    /\b(remember|forget|memory|memories|save|store|recall|remind|note|ingat|lupa|lupakan|memori|simpan|catat|ingatkan)\b/i
  ];

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['store', 'retrieve', 'forget'], description: 'Action to perform' },
            content: { type: 'string', description: 'The fact to store (required for store)' },
            id: { type: 'string', description: 'The memory ID to forget (required for forget)' }
          },
          required: ['action'],
        },
      },
    };
  }

  async execute(args: { action?: string; content?: string; id?: string }, ctx: MessageContext): Promise<string> {
    const room = (await db.select().from(chatRooms).where(eq(chatRooms.id, ctx.chatId)))[0];
    if (!room) return 'Error: Chat room not found.';
    const config = ConfigService.getResolvedConfig(room, ctx.isGroup);

    if (!config.longTermMemory) {
      return 'Error: Long-term memory is currently disabled for this chat. Use `/config set longTermMemory true` to enable it.';
    }

    const ownerId = ctx.isGroup ? ctx.chatId : ctx.senderId;
    
    switch (args.action) {
      case 'store': {
        if (!args.content) return 'Error: content is required.';
        const id = crypto.randomBytes(8).toString('hex');
        await db.insert(memories).values({
          id,
          ownerId,
          content: args.content,
          created_at: new Date()
        });
        log.info({ ownerId, id, content: args.content }, 'Stored memory');
        return `Stored memory [${id}]: ${args.content}\nThis memory will be automatically injected into your system prompt for future conversations.`;
      }
      case 'retrieve': {
        const mems = await db.select().from(memories).where(eq(memories.ownerId, ownerId));
        if (mems.length === 0) return 'No memories found for this chat/user.';
        return 'Active Memories:\n' + mems.map(m => `[${m.id}] ${m.content}`).join('\n');
      }
      case 'forget': {
        if (!args.id) return 'Error: memory ID is required to forget.';
        const deleted = await db.delete(memories).where(and(eq(memories.id, args.id), eq(memories.ownerId, ownerId))).returning();
        if (deleted.length === 0) return `Error: Memory ID ${args.id} not found.`;
        log.info({ ownerId, id: args.id }, 'Deleted memory');
        return `Forgot memory ${args.id}`;
      }
      default:
        return 'Invalid action. Use store, retrieve, or forget.';
    }
  }
}
