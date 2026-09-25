import { db } from '../db';
import { chatRooms, messages } from '../db/schema';
import { logger } from './logger';
import type { MessageContext } from '../core/MessageContext';
import { ConfigService } from './ConfigService';
import { sanitizeRawMessage } from './rawMessage';

const ROOM_BATCH_SIZE = 100;
const MESSAGE_BATCH_SIZE = 100;
const MAX_BATCHES = 50;
const MAX_HISTORICAL_MESSAGES = 5_000;

type RoomDefaults = {
  systemPrompt: string;
  contextLimit: number;
  temperature: number;
  maxTokens: number;
  allowTools: boolean;
  autoReplyAll: boolean;
  summarize: boolean;
  longTermMemory: boolean;
};

function roomDefaults(isGroup: boolean): RoomDefaults {
  const getDefaults = (ConfigService as unknown as {
    getDefaults?: (group: boolean) => RoomDefaults;
  }).getDefaults;
  return getDefaults
    ? getDefaults(isGroup)
    : {
        systemPrompt: '',
        contextLimit: 20,
        temperature: 0.7,
        maxTokens: 2_048,
        allowTools: true,
        autoReplyAll: false,
        summarize: true,
        longTermMemory: !isGroup,
      };
}

export type HistoricalSyncResult = {
  received: number;
  roomsSeen: number;
  messagesInserted: number;
  failedBatches: number;
};

async function withRetry<T>(operation: () => T | Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, Math.min(1_000, 50 * 2 ** (attempt - 1))));
      }
    }
  }
  throw lastError;
}

function historicalTimestamp(ctx: MessageContext): Date {
  const raw = ctx.rawMessage as { messageTimestamp?: unknown } | undefined;
  const value = raw?.messageTimestamp;
  const seconds = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : undefined;
  if (seconds && Number.isFinite(seconds)) {
    const date = new Date(seconds * 1_000);
    const now = Date.now() + 5 * 60_000;
    if (date.getTime() > 0 && date.getTime() <= now) return date;
  }
  return new Date();
}

export async function syncHistoricalDatabase(
  historicalMessages: MessageContext[],
): Promise<HistoricalSyncResult> {
  const selected = historicalMessages.slice(0, MAX_HISTORICAL_MESSAGES);
  const result: HistoricalSyncResult = {
    received: selected.length,
    roomsSeen: 0,
    messagesInserted: 0,
    failedBatches: 0,
  };
  if (selected.length === 0) return result;

  const knownRooms = new Map<string, typeof chatRooms.$inferInsert>();
  const payloads: (typeof messages.$inferInsert)[] = [];

  for (const ctx of selected) {
    const roomKey = `${ctx.platform}:${ctx.chatId}`;
    if (!knownRooms.has(roomKey)) {
      const defaults = roomDefaults(ctx.isGroup);
      knownRooms.set(ctx.chatId, {
        id: ctx.chatId,
        platform: ctx.platform,
        language: 'en',
        systemPrompt: defaults.systemPrompt,
        contextLimit: defaults.contextLimit,
        temperature: defaults.temperature,
        maxTokens: defaults.maxTokens,
        allowTools: defaults.allowTools,
        autoReplyAll: defaults.autoReplyAll,
        summarize: defaults.summarize,
        longTermMemory: defaults.longTermMemory,
        created_at: new Date(),
      });
    }
    const isFromMe = ctx.rawMessage?.key?.fromMe === true;
    payloads.push({
      chatRoomId: ctx.chatId,
      platform: ctx.platform,
      providerMessageId: ctx.messageId,
      senderId: ctx.senderId,
      senderName: ctx.senderName?.slice(0, 200) || 'unknown',
      role: isFromMe ? 'assistant' : 'user',
      content: ctx.text?.slice(0, 20_000) || '',
      rawMessage: sanitizeRawMessage(ctx.rawMessage),
      mimeType: ctx.text ? null : 'application/octet-stream',
      created_at: historicalTimestamp(ctx),
    });
  }
  result.roomsSeen = knownRooms.size;

  const failedRoomIds = new Set<string>();
  const rooms = Array.from(knownRooms.values());
  for (let offset = 0; offset < rooms.length && offset / ROOM_BATCH_SIZE < MAX_BATCHES; offset += ROOM_BATCH_SIZE) {
    const chunk = rooms.slice(offset, offset + ROOM_BATCH_SIZE);
    try {
      await withRetry(() => db.insert(chatRooms).values(chunk).onConflictDoNothing().run());
    } catch (error) {
      result.failedBatches++;
      for (const room of chunk) failedRoomIds.add(room.id);
      logger.error({ err: error, batch: offset / ROOM_BATCH_SIZE }, 'Historical room batch failed');
    }
  }

  for (let offset = 0; offset < payloads.length && offset / MESSAGE_BATCH_SIZE < MAX_BATCHES; offset += MESSAGE_BATCH_SIZE) {
    const chunk = payloads.slice(offset, offset + MESSAGE_BATCH_SIZE).filter(message => !failedRoomIds.has(message.chatRoomId));
    if (chunk.length === 0) continue;
    try {
      const inserted = await withRetry(async () => {
        const query = db.insert(messages).values(chunk).onConflictDoNothing();
        const returning = (query as unknown as {
          returning?: (selection: { id: typeof messages.id }) => { all: () => Array<{ id: number }> };
        }).returning;
        if (typeof returning === 'function') {
          return { count: (await returning.call(query, { id: messages.id }).all()).length };
        }
        const result = query.run() as unknown as { changes?: number } | void;
        return {
          count: typeof result?.changes === 'number' ? result.changes : chunk.length,
        };
      });
      result.messagesInserted += inserted.count;
    } catch (error) {
      result.failedBatches++;
      logger.error({ err: error, batch: offset / MESSAGE_BATCH_SIZE }, 'Historical message batch failed');
    }
  }

  if (selected.length < historicalMessages.length) {
    logger.warn({ received: historicalMessages.length, selected: selected.length }, 'Historical sync input truncated');
  }
  logger.info(result, 'Historical database sync finished');
  return result;
}
