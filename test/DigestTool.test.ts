import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';
import { db } from '../src/db';
import { chatRooms } from '../src/db/schema';
import { eq } from 'drizzle-orm';

let roomRow: { language: string } | undefined = { language: 'en' };

const TEST_CHAT_ROOM_ID = 'chat-1';
const TEST_ROOM_KEY = 'room:whatsapp:chat-1';

async function seedRoom(language: string): Promise<void> {
  await db.insert(chatRooms).values({
    id: TEST_CHAT_ROOM_ID,
    platform: 'whatsapp',
    language,
    roomKey: TEST_ROOM_KEY,
    created_at: new Date(),
  }).onConflictDoUpdate({ target: chatRooms.id, set: { language } });
}

async function clearRoom(): Promise<void> {
  await db.delete(chatRooms).where(eq(chatRooms.id, TEST_CHAT_ROOM_ID));
}

const summarizeCalls: { roomId: string; hours: number; maxMessages: number; lang?: string | null }[] = [];
let summarizeResult: { text: string; messageCount: number } | null = null;
let summarizeError: Error | null = null;

// Spread the REAL module and override only summarizeRoom, so other files
// sharing this worker keep working DigestService/DigestDeps exports.
import * as realDigestModule from '../src/utils/DigestService';
mock.module('../src/utils/DigestService', () => ({
  ...realDigestModule,
  summarizeRoom: mock(async (roomId: string, opts: { hours: number; maxMessages: number; lang?: string | null }) => {
    summarizeCalls.push({ roomId, hours: opts.hours, maxMessages: opts.maxMessages, lang: opts.lang });
    if (summarizeError) throw summarizeError;
    return summarizeResult;
  }),
}));

import { DigestTool, digestToolDeps } from '../src/tools/DigestTool';

const createMockCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: TEST_CHAT_ROOM_ID,
  senderId: 'user-1',
  senderName: 'User',
  text: '',
  isGroup: false,
  isBotMentioned: false,
  hasMedia: false,
  language: 'en',
  messageType: 'conversation',
  messageId: 'msg-1',
  mediaReady: Promise.resolve(),
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  resolveRoles: mock(async () => ['user']),
  rawMessage: {},
  ...overrides,
} as MessageContext);

beforeEach(async () => {
  summarizeCalls.length = 0;
  summarizeResult = null;
  summarizeError = null;
  roomRow = { language: 'en' };
  delete digestToolDeps.callLLM;
  await clearRoom();
  await seedRoom(roomRow!.language);
});

describe('DigestTool', () => {
  const tool = new DigestTool();

  test('basic properties', () => {
    expect(tool.name).toBe('digest');
    expect(tool.aliases).toContain('ringkasan');
  });

  test('defaults to 24h and uses the room language for summarization', async () => {
    summarizeResult = { text: '• stuff happened', messageCount: 10 };
    const result = await tool.execute({}, createMockCtx());
    // The digest is room scoped, so DigestService receives the canonical key.
    expect(summarizeCalls[0]).toMatchObject({ roomId: 'room:whatsapp:chat-1', hours: 24, lang: 'en' });
    expect(result).toContain('Summary of the last 24h');
    expect(result).toContain('stuff happened');
  });

  test('passes a context room key through unchanged', async () => {
    summarizeResult = { text: 'x', messageCount: 1 };
    await tool.execute({}, createMockCtx({ roomKey: 'room:whatsapp:alias-1' }));
    expect(summarizeCalls[0]).toMatchObject({ roomId: 'room:whatsapp:alias-1' });
  });

  test('parses string hours and clamps to [1..168]', async () => {
    summarizeResult = { text: 'x', messageCount: 1 };
    await tool.execute({ hours: '72' }, createMockCtx());
    expect(summarizeCalls[0]!.hours).toBe(72);

    await tool.execute({ hours: 500 }, createMockCtx());
    expect(summarizeCalls[1]!.hours).toBe(168);

    await tool.execute({ hours: -5 }, createMockCtx());
    expect(summarizeCalls[2]!.hours).toBe(1);

    await tool.execute({ hours: 'abc' }, createMockCtx());
    expect(summarizeCalls[3]!.hours).toBe(24);
  });

  test('no messages → localized no_messages reply', async () => {
    summarizeResult = null;
    const result = await tool.execute({ hours: 48 }, createMockCtx());
    expect(result).toBe('No messages in the last 48h to summarize.');
  });

  test('Indonesian room + Indonesian user locale get id strings', async () => {
    roomRow = { language: 'id' };
    summarizeResult = null;
    const result = await tool.execute({ hours: 12 }, createMockCtx({ language: 'id' }));
    expect(result).toBe('Tidak ada pesan dalam 12 jam terakhir untuk diringkas.');
  });

  test('failure surfaces localized error with reason', async () => {
    summarizeError = new Error('provider exploded');
    const result = await tool.execute({}, createMockCtx());
    expect(result).toContain('Failed to generate the digest.');
    expect(result).toContain('provider exploded');
  });
});
