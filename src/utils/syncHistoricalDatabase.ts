import { or } from 'drizzle-orm';
import { db } from '../db';
import { chatRooms, messages } from '../db/schema';
import { logger } from './logger';
import type { MessageContext } from '../core/MessageContext';
import { ConfigService } from './ConfigService';
import { sanitizeRawMessage } from './rawMessage';
import {
  chatRoomKeyInsertValues,
  chatRoomsRoomColumns,
  getCanonicalRoomKey,
  hasCanonicalRoomKeyColumns,
  messageRoomKeyInsertValues,
  pickPreferredRoomRow,
  resolveRoomIdentity,
  roomIdentityCondition,
} from '../agent/roomKey';

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

  const contextsByRoomKey = new Map<string, MessageContext>();
  for (const ctx of selected) {
    const roomKey = getCanonicalRoomKey(ctx);
    if (!contextsByRoomKey.has(roomKey)) contextsByRoomKey.set(roomKey, ctx);
  }

  const identities = new Map<string, ReturnType<typeof resolveRoomIdentity>>();
  for (const [roomKey, ctx] of contextsByRoomKey) {
    identities.set(roomKey, resolveRoomIdentity({ ...ctx, roomKey }));
  }
  const roomConditions = [...identities.values()].map(identity =>
    roomIdentityCondition(chatRoomsRoomColumns(), identity),
  );
  const roomQuery = db.select().from(chatRooms) as unknown as {
    where?: (condition: unknown) => Promise<typeof chatRooms.$inferSelect[]> | typeof chatRooms.$inferSelect[];
    then?: (resolve: (value: typeof chatRooms.$inferSelect[]) => unknown) => unknown;
  };
  let existingRoomRows: Array<typeof chatRooms.$inferSelect> = [];
  if (roomConditions.length === 1 && typeof roomQuery.where === 'function') {
    existingRoomRows = await roomQuery.where(roomConditions[0]);
  } else if (roomConditions.length > 1 && typeof roomQuery.where === 'function') {
    existingRoomRows = await roomQuery.where(or(...roomConditions)!);
  } else {
    const resolved = await (roomQuery as unknown as Promise<Array<typeof chatRooms.$inferSelect>>);
    existingRoomRows = Array.isArray(resolved) ? resolved : [];
  }

  const knownRooms = new Map<string, typeof chatRooms.$inferInsert>();
  const internalRoomIds = new Map<string, string>();
  const canonicalRoomIdsEnabled = hasCanonicalRoomKeyColumns();

  for (const [roomKey, ctx] of contextsByRoomKey) {
    const identity = identities.get(roomKey)!;
    const matches = existingRoomRows.filter(row =>
      row.roomKey === roomKey
      || (row.id === identity.roomId && row.platform === identity.platform),
    );
    const existing = pickPreferredRoomRow(matches, roomKey);
    if (existing) {
      internalRoomIds.set(roomKey, existing.id);
      continue;
    }

    const defaults = roomDefaults(ctx.isGroup);
    const internalRoomId = canonicalRoomIdsEnabled ? roomKey : identity.roomId;
    const room: typeof chatRooms.$inferInsert = {
      id: internalRoomId,
      ...chatRoomKeyInsertValues(roomKey),
      platform: identity.platform,
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
    };
    knownRooms.set(roomKey, room);
    internalRoomIds.set(roomKey, internalRoomId);
  }
  result.roomsSeen = contextsByRoomKey.size;

  const failedRoomIds = new Set<string>();
  const rooms = [...knownRooms.values()];
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

  const payloads: (typeof messages.$inferInsert)[] = [];
  for (const ctx of selected) {
    const roomKey = getCanonicalRoomKey(ctx);
    const roomId = internalRoomIds.get(roomKey);
    if (!roomId || failedRoomIds.has(roomId)) continue;
    const isFromMe = ctx.rawMessage?.key?.fromMe === true;
    payloads.push({
      chatRoomId: roomId,
      ...messageRoomKeyInsertValues(roomKey),
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
