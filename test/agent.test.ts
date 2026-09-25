import { describe, test, expect, afterAll, afterEach, beforeEach, mock, spyOn } from 'bun:test';
import { desc, eq, or } from 'drizzle-orm';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Environment must be configured before the agent module (and therefore the
//    ModelRouter singleton) is evaluated, so the import is dynamic. ───────────
process.env.AI_API_KEY = 'test-key';
process.env.AI_MODEL_NAME = 'test-model';
process.env.AI_API_BASE_URL = 'https://ai.test.local/v1';
process.env.AI_MAX_TOKENS = '512';
process.env.AI_TEMPERATURE = '0.5';
process.env.AI_STREAMING = 'true';
process.env.AI_VERBOSE_LOGS = 'false';
process.env.CONTEXT_MESSAGE_LIMIT = '10';

import * as toolsModule from '../src/tools';
import { BaseTool, type ToolArgs, type ToolDefinition, type ToolResult } from '../src/tools/BaseTool';
import { createTempDatabase, type TempDatabase } from './helpers/database';
import { chatRooms, messages } from '../src/db/schema';
import { toRoomKey } from '../src/agent/roomKey';

// ── Module mock backed by a real migrated temp database ──────────────────────
// Bun module mocks are process-wide, so this fake must expose the full
// `../src/db` surface or every other test file importing the real module breaks.
const database: TempDatabase = createTempDatabase();

// Mirrors src/db/runtime.ts exactly: the return value must be propagated,
// because callers such as claimInboxEvents rely on it.
function withImmediateTransaction<T>(sqlite: TempDatabase['sqlite'], operation: () => T): T {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      sqlite.exec('ROLLBACK');
    } catch {
      // The transaction may already be rolled back; surface the original error.
    }
    throw error;
  }
}

mock.module('../src/db', () => ({
  db: database.db,
  sqlite: database.sqlite,
  withImmediateTransaction,
}));

const db = database.db;
import type { MessageContext } from '../src/core/MessageContext';
import { createTempMediaDir } from './helpers/tempMedia';

const { handleIncomingMessage } = await import('../src/agent/index');

// Every test uses its own room/sender identity so parallel files sharing the
// worker database cannot collide with these rows.
const RUN_TOKEN = Math.random().toString(36).slice(2, 10);
let idCounter = 0;
const nextId = (prefix: string): string => `${prefix}-${RUN_TOKEN}-${++idCounter}`;

const originalFetch = global.fetch;

// ES module namespaces are read-only, so the registry is stubbed through
// spyOn() and every stub is restored after each test.
const registrySpies: Array<{ mockRestore(): void }> = [];

function stubRegistry(name: string, implementation: unknown): void {
  const target = toolsModule as unknown as Record<string, (this: unknown, ...args: never[]) => unknown>;
  registrySpies.push(spyOn(target, name as never).mockImplementation(implementation as never));
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

class FakeTool extends BaseTool {
  readonly name: string;
  private readonly handler: (args: Record<string, unknown>, ctx: MessageContext) => Promise<ToolResult>;
  private readonly argSchema: ToolDefinition['function']['parameters'];

  constructor(
    name: string,
    handler: (args: Record<string, unknown>, ctx: MessageContext) => Promise<ToolResult>,
    argSchema: ToolDefinition['function']['parameters'] = {
      type: 'object',
      properties: { query: { type: 'string', description: 'search query' } },
      required: [],
      additionalProperties: false,
    },
  ) {
    super();
    this.name = name;
    this.handler = handler;
    this.argSchema = argSchema;
    this.description = `fake ${name}`;
  }
  readonly description: string;
  readonly aliases: string[] = [];
  readonly category = 'test';
  readonly permissions = 'user';
  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: { name: this.name, description: this.description, parameters: this.argSchema },
    };
  }
  async execute(args: ToolArgs, ctx: MessageContext): Promise<ToolResult> {
    return this.handler(args as Record<string, unknown>, ctx);
  }
}

const mediaDir = createTempMediaDir();
function writeMediaFile(name: string, contents: string): string {
  const path = join(mediaDir, `${RUN_TOKEN}-${name}`);
  writeFileSync(path, contents, 'utf8');
  return path;
}

function makeFetchResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: {} }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeToolCallResponse(toolCalls: Array<{ id: string; name: string; args: string }>): Response {
  return new Response(
    JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.args },
          })),
        },
      }],
      usage: {},
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

type MockFn = ReturnType<typeof mock>;
type MockCtx = MessageContext & {
  reply: MockFn;
  react: MockFn;
  sendMedia: MockFn;
  checkPermissions: MockFn;
  resolveRoles: MockFn;
  sendTyping: MockFn;
  verifyRoomMembership: MockFn;
};

const makeCtx = (overrides: Partial<MessageContext> = {}): MockCtx => ({
  platform: 'whatsapp',
  chatId: nextId('room'),
  senderId: nextId('sender'),
  senderName: 'Alice',
  text: '',
  isGroup: false,
  isBotMentioned: false,
  isGroupAdmin: false,
  hasMedia: false,
  messageType: 'conversation',
  mediaReady: Promise.resolve(),
  language: 'en',
  mentionedIds: [],
  rawMessage: { key: { id: nextId('stanza') } },
  messageId: nextId('msg'),
  reply: mock(async () => undefined),
  react: mock(async () => undefined),
  sendMedia: mock(async () => undefined),
  sendTyping: mock(async () => undefined),
  checkPermissions: mock(async () => true),
  resolveRoles: mock(async () => ['user', 'owner']),
  verifyRoomMembership: mock(async () => true),
  ...overrides,
} as unknown as MockCtx);

async function seedRoom(id: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await db.insert(chatRooms).values({
    id,
    platform: 'whatsapp',
    language: 'en',
    systemPrompt: 'You are ElastraX.',
    allowTools: true,
    longTermMemory: false,
    created_at: new Date(),
    ...overrides,
  }).run();
}

async function seedHistory(chatId: string, rows: Array<{ role: string; content: string; senderName: string; mediaPath?: string | null; mimeType?: string | null; providerMessageId?: string; createdAt?: Date }>): Promise<void> {
  // messages.chat_room_id is a foreign key, so the room must exist first.
  await db.insert(chatRooms).values({
    id: chatId,
    platform: 'whatsapp',
    language: 'en',
    systemPrompt: 'You are ElastraX.',
    allowTools: true,
    longTermMemory: false,
    created_at: new Date(),
  }).onConflictDoNothing().run();
  for (const [index, row] of rows.entries()) {
    await db.insert(messages).values({
      chatRoomId: chatId,
      senderId: `${row.senderName}@s.whatsapp.net`,
      senderName: row.senderName,
      role: row.role,
      content: row.content,
      platform: 'whatsapp',
      providerMessageId: row.providerMessageId ?? nextId('hist'),
      mediaPath: row.mediaPath ?? null,
      mimeType: row.mimeType ?? null,
      created_at: row.createdAt ?? new Date(),
    }).run();
    void index;
  }
}

const roomRow = (id: string) => {
  const roomKey = toRoomKey('whatsapp', id);
  return db.select().from(chatRooms)
    .where(or(eq(chatRooms.id, id), eq(chatRooms.id, roomKey), eq(chatRooms.roomKey, roomKey)))
    .then(rows => rows[0]);
};
const messagesFor = (chatId: string) => {
  const roomKey = toRoomKey('whatsapp', chatId);
  return db.select().from(messages)
    .where(or(
      eq(messages.chatRoomId, chatId),
      eq(messages.chatRoomId, roomKey),
      eq(messages.roomKey, roomKey),
    ))
    .orderBy(desc(messages.created_at));
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('handleIncomingMessage', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AI_STREAMING = 'true';
    process.env.AI_MAX_TOKENS = '512';
    process.env.AI_TEMPERATURE = '0.5';
    process.env.AI_VERBOSE_LOGS = 'false';
    process.env.AI_TOOL_TIMEOUT_MS = '30000';
    process.env.AI_MAX_TOOL_ITERATIONS = '8';
    global.fetch = mock(async () => makeFetchResponse('Hello, I am ElastraX!')) as unknown as typeof global.fetch;

    while (registrySpies.length > 0) registrySpies.pop()!.mockRestore();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  afterAll(() => {
    database.cleanup();
  });

  // ── Room initialisation ─────────────────────────────────────────────────────

  describe('room initialisation', () => {
    test('creates a room with platform defaults when the chat is new', async () => {
      const ctx = makeCtx({ text: 'Hello' });
      await handleIncomingMessage(ctx);

      const room = await roomRow(ctx.chatId);
      expect(room).toBeDefined();
      expect(room?.platform).toBe('whatsapp');
      expect(room?.language).toBe('en');
      expect(room?.systemPrompt).toBeTruthy();
    });

    test('reuses an existing room and honours its stored language', async () => {
      const chatId = nextId('room');
      await seedRoom(chatId, { language: 'id', systemPrompt: 'Kamu adalah ElastraX.' });

      const ctx = makeCtx({ chatId, text: 'Halo' });
      await handleIncomingMessage(ctx);

      expect(ctx.language).toBe('id');
      const rows = await db.select().from(chatRooms).where(eq(chatRooms.id, chatId));
      expect(rows).toHaveLength(1);
    });

    test('treats a zero contextLimit in the database as unset and uses the default', async () => {
      const chatId = nextId('room');
      await seedRoom(chatId, { contextLimit: 0 });

      const ctx = makeCtx({ chatId, text: 'Hello' });
      await handleIncomingMessage(ctx);

      const [, fetchInit] = (global.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
      const body = JSON.parse(fetchInit.body as string) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages[0]?.content).toBeTruthy();
    });
  });

  // ── Private DM AI conversation ──────────────────────────────────────────────

  describe('private DM – AI conversation', () => {
    test('sends the AI reply for a private DM', async () => {
      const ctx = makeCtx({ isGroup: false, text: 'Hello' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith('Hello, I am ElastraX!', undefined);
    });

    test('reacts with ⏳ before the AI response and ✅ after', async () => {
      const ctx = makeCtx({ isGroup: false, text: 'Hi' });
      await handleIncomingMessage(ctx);
      const calls = ctx.react.mock.calls.map(call => call[0]);
      expect(calls).toContain('⏳');
      expect(calls).toContain('✅');
    });

    test('saves the user message and the AI response to the database', async () => {
      const ctx = makeCtx({ isGroup: false, text: 'Test message' });
      await handleIncomingMessage(ctx);

      const stored = await messagesFor(ctx.chatId);
      const userMsg = stored.find(row => row.role === 'user');
      const aiMsg = stored.find(row => row.role === 'assistant');
      expect(userMsg?.content).toBe('Test message');
      expect(userMsg?.platform).toBe('whatsapp');
      expect(aiMsg?.content).toBe('Hello, I am ElastraX!');
      expect(aiMsg?.senderName).toBe('ElastraX');
    });

    test('stays on the non-streaming path when the context cannot stream', async () => {
      process.env.AI_STREAMING = 'true';
      const ctx = makeCtx({ isGroup: false, text: 'Hello' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith('Hello, I am ElastraX!', undefined);
    });

    test('ignores a duplicate provider event instead of replying twice', async () => {
      const ctx = makeCtx({ isGroup: false, text: 'Hello' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply.mock.calls.length).toBe(1);

      const duplicate = makeCtx({
        chatId: ctx.chatId,
        messageId: ctx.messageId,
        text: 'Hello',
        isGroup: false,
      });
      await handleIncomingMessage(duplicate);

      expect(duplicate.reply).not.toHaveBeenCalled();
      const userMessages = (await messagesFor(ctx.chatId)).filter(row => row.role === 'user');
      expect(userMessages).toHaveLength(1);
    });

    test('recovers gracefully when the AI call throws', async () => {
      global.fetch = mock(async () => {
        throw new Error('Network failure');
      }) as unknown as typeof global.fetch;
      const ctx = makeCtx({ isGroup: false, text: 'trigger error' });
      await expect(handleIncomingMessage(ctx)).resolves.toBeUndefined();
      expect(ctx.reply.mock.calls.length).toBeGreaterThan(0);
    });

    test('returns a rate-limit notice when the sender exceeds their window', async () => {
      const senderId = nextId('ratelimited');
      const chatId = nextId('room');
      await seedRoom(chatId, { longTermMemory: 0 });
      // Role privilege overrides come from the environment, so a plain 'user'
      // caller is throttled to one message per hour.
      process.env.ROLE_PRIV_USER_MESSAGES_PER_WINDOW = '1';
      process.env.ROLE_PRIV_USER_RATE_WINDOW_SEC = '3600';

      const roles = mock(async () => ['user']);
      const first = makeCtx({ chatId, senderId, text: 'one', resolveRoles: roles });
      await handleIncomingMessage(first);
      expect(first.reply.mock.calls.length).toBe(1);

      const second = makeCtx({ chatId, senderId, text: 'two', resolveRoles: roles });
      await handleIncomingMessage(second);
      expect(String(second.reply.mock.calls[0]?.[0] ?? '')).toContain('Slow down');

      const stored = await messagesFor(chatId);
      expect(stored.some(row => row.content === 'two')).toBe(false);
    });
  });

  // ── Group messages ──────────────────────────────────────────────────────────

  describe('group messages', () => {
    test('does NOT reply in a group when not triggered', async () => {
      const ctx = makeCtx({ isGroup: true, text: 'random group message', mentionedIds: [] });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
      // The message is still ingested for context.
      const stored = await messagesFor(ctx.chatId);
      expect(stored.some(row => row.role === 'user' && row.content === 'random group message')).toBe(true);
    });

    test('replies in a group when the bot is @mentioned', async () => {
      const ctx = makeCtx({ isGroup: true, text: 'Hey @bot what is 2+2?', mentionedIds: ['bot@s.whatsapp.net'], isBotMentioned: true });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });

    test('does NOT reply when another user is @mentioned', async () => {
      const ctx = makeCtx({ isGroup: true, text: 'Hey @user2 what is 2+2?', mentionedIds: ['user2@s.whatsapp.net'] });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    test('replies in a group when the user replies to a bot message', async () => {
      const ctx = makeCtx({
        isGroup: true,
        text: 'OK thanks',
        mentionedIds: [],
        quoted: {
          messageType: 'conversation',
          body: 'I can help!',
          text: 'I can help!',
          senderId: 'bot',
          hasMedia: false,
          rawMessage: { key: { fromMe: true } },
        },
      });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });

    test('strips the /chat prefix from the user content', async () => {
      const ctx = makeCtx({ isGroup: true, text: '/chat What is AI?', mentionedIds: [] });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith('Hello, I am ElastraX!', undefined);

      const stored = await messagesFor(ctx.chatId);
      expect(stored.find(row => row.role === 'user')?.content).toBe('What is AI?');
    });
  });

  // ── Explicit slash command routing (real registry) ──────────────────────────

  describe('explicit slash command routing', () => {
    test('routes a /menu command to the real MenuTool', async () => {
      const ctx = makeCtx({ text: '/menu', isGroup: false });
      await handleIncomingMessage(ctx);
      const replyText = String(ctx.reply.mock.calls.at(-1)?.[0] ?? '');
      expect(replyText.length).toBeGreaterThan(0);
      expect(replyText.toLowerCase()).toContain('menu');
    });

    test('routes a command through the durable outbox without calling the model', async () => {
      global.fetch = mock(async () => {
        throw new Error('LLM must not be called for explicit commands');
      }) as unknown as typeof global.fetch;
      const ctx = makeCtx({ text: '/ping', isGroup: false });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const stored = await messagesFor(ctx.chatId);
      expect(stored).toHaveLength(0);
      expect(ctx.reply).toHaveBeenCalledWith(expect.any(String), {});
    });

    test('reacts with 🔧 before executing a command and ✅ after', async () => {
      const ctx = makeCtx({ text: '/menu', isGroup: false });
      await handleIncomingMessage(ctx);
      const calls = ctx.react.mock.calls.map(call => call[0]);
      expect(calls).toContain('🔧');
      expect(calls).toContain('✅');
    });

    test('refuses a command the caller lacks permission for', async () => {
      const chatId = nextId('room');
      await seedRoom(chatId, { language: 'en' });
      const ctx = makeCtx({
        chatId,
        text: '/language set en',
        isGroup: false,
        checkPermissions: mock(async () => false),
        resolveRoles: mock(async () => ['user']),
      });
      await handleIncomingMessage(ctx);
      const replyText = String(ctx.reply.mock.calls.at(-1)?.[0] ?? '');
      expect(replyText.toLowerCase()).toContain('unknown command');
      const room = await roomRow(chatId);
      expect(room?.language).toBe('en');
    });

    test('replies with a validation message when a command argument is rejected', async () => {
      const chatId = nextId('room');
      await seedRoom(chatId, { language: 'en' });
      const ctx = makeCtx({ chatId, text: '/config set contextLimit not-a-number', isGroup: false });
      await handleIncomingMessage(ctx);
      expect(String(ctx.reply.mock.calls.at(-1)?.[0] ?? '')).toContain('Invalid value for contextLimit');
      const calls = ctx.react.mock.calls.map(call => call[0]);
      expect(calls).toContain('✅');
    });

    test('replies with the internal error message and ❌ when a command tool throws', async () => {
      const boom = new FakeTool('boom', async () => {
        throw new Error('Tool crashed!');
      });
      stubRegistry('getAuthorizedTool', async () => boom);
      stubRegistry('getToolByAliasOrName', () => boom);

      const ctx = makeCtx({ text: '/boom', isGroup: false });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith('An internal error occurred while processing your message.', {});
      const calls = ctx.react.mock.calls.map(call => call[0]);
      expect(calls).toContain('❌');
    });

    test('times out a hanging slash command tool instead of blocking forever', async () => {
      process.env.AI_TOOL_TIMEOUT_MS = '10';
      const stuck = new FakeTool('stuck', () => new Promise<string>(() => {}));
      stubRegistry('getAuthorizedTool', async () => stuck);
      stubRegistry('getToolByAliasOrName', () => stuck);

      const ctx = makeCtx({ text: '/stuck', isGroup: false });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith('An internal error occurred while processing your message.', {});
      const calls = ctx.react.mock.calls.map(call => call[0]);
      expect(calls).toContain('❌');
    });

    test('replies "Unknown command" for an unrecognised slash command', async () => {
      const ctx = makeCtx({ text: '/xyzzy_super_random_command_123', isGroup: false });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Unknown command'), {});
    });

    test('suggests a similar command when a typo is made (/men -> /menu)', async () => {
      const ctx = makeCtx({ text: '/men', isGroup: false });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Did you mean *`/menu`*'), {});
    });

    test('suggests a similar command based on an alias (/hlp -> /help)', async () => {
      const ctx = makeCtx({ text: '/hlp', isGroup: false });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Did you mean *`/help`*'), {});
    });
  });

  // ── Tool call loop (AI requesting tools) ───────────────────────────────────

  describe('tool call loop (AI requesting tools)', () => {
    function registerTool(tool: BaseTool): void {
      stubRegistry('getToolByName', (name: string) => (name === tool.name ? tool : undefined));
      stubRegistry('getToolsForContext', () => [tool]);
      stubRegistry('getAlwaysLoadedDefinitions', () => [tool.definition]);
      stubRegistry('getTriggeredTools', () => []);
      stubRegistry('getToolDefinitions', () => [tool.definition]);
    }

    function registerNoTools(): void {
      stubRegistry('getToolByName', () => undefined);
      stubRegistry('getToolsForContext', () => []);
      stubRegistry('getAlwaysLoadedDefinitions', () => []);
      stubRegistry('getTriggeredTools', () => []);
      stubRegistry('getToolDefinitions', () => []);
    }

    test('executes a tool the AI requests and then replies with the final text', async () => {
      const execute = mock(async () => 'Search results here');
      registerTool(new FakeTool('web_search', execute));

      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        if (callCount === 1) {
          return makeToolCallResponse([{ id: 'call-1', name: 'web_search', args: '{"query":"bun"}' }]);
        }
        return makeFetchResponse('Here are the results!');
      }) as unknown as typeof global.fetch;

      const ctx = makeCtx({ isGroup: false, text: 'Search for bun' });
      await handleIncomingMessage(ctx);

      expect(execute).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Here are the results!', undefined);
    });

    test('reports an unknown tool name to the model instead of crashing', async () => {
      registerNoTools();

      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        if (callCount === 1) {
          return makeToolCallResponse([{ id: 'call-x', name: 'nonexistent', args: '{}' }]);
        }
        return makeFetchResponse('Fallback answer');
      }) as unknown as typeof global.fetch;

      const ctx = makeCtx({ isGroup: false, text: 'Do something' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith('Fallback answer', undefined);
    });

    test('rejects malformed tool arguments and tells the model', async () => {
      const execute = mock(async () => 'ok');
      registerTool(new FakeTool('web_search', execute));

      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        if (callCount === 1) {
          return makeToolCallResponse([{ id: 'call-bad', name: 'web_search', args: 'NOT_JSON' }]);
        }
        return makeFetchResponse('Done');
      }) as unknown as typeof global.fetch;

      const ctx = makeCtx({ isGroup: false, text: 'trigger malformed args' });
      await handleIncomingMessage(ctx);
      expect(execute).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Done', undefined);

      const [, fetchInit] = (global.fetch as unknown as ReturnType<typeof mock>).mock.calls[1]!;
      const body = JSON.parse(fetchInit.body as string) as { messages: Array<{ role: string; content: string }> };
      const toolMessage = body.messages.find(message => message.role === 'tool');
      expect(toolMessage?.content).toContain('valid JSON object');
    });

    test('refuses unauthorized AI-requested tools instead of executing them', async () => {
      const execute = mock(async () => 'should not run');
      registerNoTools();
      stubRegistry('getToolByName', () => new FakeTool('owner_admin', execute));

      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        if (callCount === 1) {
          return makeToolCallResponse([{ id: 'call-owner', name: 'owner_admin', args: '{}' }]);
        }
        return makeFetchResponse('Denied');
      }) as unknown as typeof global.fetch;

      const ctx = makeCtx({ isGroup: false, text: 'do owner stuff' });
      await handleIncomingMessage(ctx);

      expect(execute).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Denied', undefined);
    });

    test('times out AI-requested tools and falls back with an error response', async () => {
      process.env.AI_TOOL_TIMEOUT_MS = '10';
      const execute = mock(() => new Promise<string>(() => {}));
      registerTool(new FakeTool('web_search', execute));

      global.fetch = mock(async () => makeToolCallResponse([{ id: 'call-timeout', name: 'web_search', args: '{"query":"bun"}' }])) as unknown as typeof global.fetch;

      const ctx = makeCtx({ isGroup: false, text: 'Search for bun' });
      await handleIncomingMessage(ctx);

      expect(execute).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('An internal error occurred'), undefined);
    });
  });

  // ── Empty / no-op messages ──────────────────────────────────────────────────

  describe('empty / no-op messages', () => {
    test('does nothing if text is empty and there is no media (private DM)', async () => {
      const ctx = makeCtx({ isGroup: false, text: '', hasMedia: false });
      await handleIncomingMessage(ctx);
      const stored = await messagesFor(ctx.chatId);
      expect(stored.find(row => row.role === 'assistant')).toBeUndefined();
    });
  });

  // ── Quoted message context ──────────────────────────────────────────────────

  describe('quoted message context', () => {
    async function storedUserContent(ctx: MockCtx): Promise<string> {
      const stored = await messagesFor(ctx.chatId);
      return stored.find(row => row.role === 'user')?.content ?? '';
    }

    test('prepends the quoted text as untrusted context', async () => {
      const ctx = makeCtx({
        isGroup: false,
        text: 'Is that right?',
        quoted: {
          messageType: 'conversation',
          body: 'ElastraX is awesome',
          text: 'ElastraX is awesome',
          senderId: 'other-user',
          hasMedia: false,
          rawMessage: { key: { fromMe: false } },
        },
      });
      await handleIncomingMessage(ctx);
      const content = await storedUserContent(ctx);
      expect(content).toContain('<quoted_message trust="untrusted">');
      expect(content).toContain('ElastraX is awesome');
      expect(content).toContain('Is that right?');
    });

    test('labels the bot\'s own quoted messages as "ElastraX (You)"', async () => {
      const ctx = makeCtx({
        isGroup: false,
        text: 'yes exactly',
        quoted: {
          messageType: 'conversation',
          body: 'I said something',
          text: 'I said something',
          senderId: 'bot',
          hasMedia: false,
          rawMessage: { key: { fromMe: true } },
        },
      });
      await handleIncomingMessage(ctx);
      expect(await storedUserContent(ctx)).toContain('ElastraX (You)');
    });

    test('truncates very long quoted text with an ellipsis', async () => {
      const longText = 'A'.repeat(200);
      const ctx = makeCtx({
        isGroup: false,
        text: 'ok',
        quoted: {
          messageType: 'conversation',
          body: longText,
          text: longText,
          senderId: 'user-x',
          hasMedia: false,
          rawMessage: { key: { fromMe: false } },
        },
      });
      await handleIncomingMessage(ctx);
      const content = await storedUserContent(ctx);
      expect(content).toContain('...');
      expect(content).not.toContain(longText);
    });

    test('uses "<Media attached>" when the quoted message has media but no text', async () => {
      const ctx = makeCtx({
        isGroup: false,
        text: 'cool pic',
        quoted: {
          messageType: 'imageMessage',
          body: '',
          text: '',
          senderId: 'user-y',
          hasMedia: true,
          rawMessage: { key: { fromMe: false } },
        },
      });
      await handleIncomingMessage(ctx);
      expect(await storedUserContent(ctx)).toContain('Media attached');
    });
  });

  // ── Media handling ──────────────────────────────────────────────────────────

  describe('media handling', () => {
    test('reacts with 📥 and persists the downloaded media path', async () => {
      const mediaPath = writeMediaFile('agent.jpg', 'not-a-real-jpeg');
      const ctx = makeCtx({
        isGroup: false,
        text: 'what is in this image?',
        hasMedia: true,
        mediaPath,
        mimeType: 'image/jpeg',
        mediaReady: Promise.resolve(),
      });
      await handleIncomingMessage(ctx);

      const calls = ctx.react.mock.calls.map(call => call[0]);
      expect(calls).toContain('📥');

      const stored = await messagesFor(ctx.chatId);
      const userMsg = stored.find(row => row.role === 'user');
      expect(userMsg?.mediaPath).toBe(mediaPath);
      expect(userMsg?.mimeType).toBe('image/jpeg');
    });

    test('persists the quoted media path as well', async () => {
      const mediaPath = writeMediaFile('quoted.jpg', 'not-a-real-jpeg');
      const quotedStanzaId = nextId('quoted');
      const ctx = makeCtx({
        isGroup: false,
        text: 'describe the quoted image too',
        hasMedia: true,
        mediaPath: writeMediaFile('main.jpg', 'not-a-real-jpeg'),
        mimeType: 'image/jpeg',
        mediaReady: Promise.resolve(),
        quoted: {
          messageType: 'imageMessage',
          body: 'old photo',
          text: 'old photo',
          senderId: 'user-x',
          hasMedia: true,
          stanzaId: quotedStanzaId,
          mediaPath,
          mimeType: 'image/jpeg',
          rawMessage: {},
        },
      });
      await seedHistory(ctx.chatId, [
        { role: 'user', content: 'old photo', senderName: 'user-x', providerMessageId: quotedStanzaId },
      ]);

      await handleIncomingMessage(ctx);

      const stored = await messagesFor(ctx.chatId);
      expect(stored.find(row => row.providerMessageId === quotedStanzaId)?.mediaPath).toBe(mediaPath);
    });

    test.each([
      ['image/jpeg', 'image.jpg'],
      ['video/mp4', 'video.mp4'],
      ['audio/ogg', 'audio.ogg'],
      ['application/pdf', 'document.pdf'],
    ])('builds AI context for %s attachments from history', async (mimeType, fileName) => {
      const mediaPath = writeMediaFile(fileName, 'payload');
      const chatId = nextId('room');
      await seedHistory(chatId, [
        { role: 'user', content: 'previous media', senderName: 'Alice', mediaPath, mimeType, createdAt: new Date(Date.now() - 60_000) },
      ]);

      const ctx = makeCtx({ chatId, isGroup: false, text: 'describe it' });
      await handleIncomingMessage(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const [, fetchInit] = (global.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
      const body = JSON.parse(fetchInit.body as string) as { messages: Array<{ content: unknown }> };
      const serialized = JSON.stringify(body.messages);
      expect(serialized).toContain('previous media');
    });
  });

  // ── autoReplyAll group behaviour ────────────────────────────────────────────

  describe('group autoReplyAll', () => {
    test('responds in a group when autoReplyAll is enabled on the room', async () => {
      const chatId = nextId('room');
      await seedRoom(chatId, { autoReplyAll: 1 });
      const ctx = makeCtx({ chatId, isGroup: true, text: 'what is the weather?' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });
  });

  // ── History context ─────────────────────────────────────────────────────────

  describe('history context assembly', () => {
    test('includes previous messages in the AI context window', async () => {
      const chatId = nextId('room');
      await seedHistory(chatId, [
        { role: 'user', content: 'hello there', senderName: 'Alice' },
        { role: 'assistant', content: 'Hi Alice!', senderName: 'ElastraX' },
      ]);

      const ctx = makeCtx({ chatId, isGroup: false, text: 'remember me?' });
      await handleIncomingMessage(ctx);

      const [, fetchInit] = (global.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
      const body = JSON.parse(fetchInit.body as string) as { messages: Array<{ role: string; content: string }> };
      // History rows are replayed with a speaker label and treated as untrusted.
      expect(body.messages.some(message => message.role === 'user' && message.content.includes('hello there'))).toBe(true);
      expect(body.messages.some(message => message.role === 'assistant' && message.content === 'Hi Alice!')).toBe(true);
    });

    test('announces the resolved roles to the model', async () => {
      const ctx = makeCtx({ isGroup: false, text: 'who am I?' });
      await handleIncomingMessage(ctx);

      const [, fetchInit] = (global.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
      const body = JSON.parse(fetchInit.body as string) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages[0]?.content).toContain('Current user roles:');
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  describe('error handling', () => {
    test('replies with the internal error message and ❌ when media ingestion fails', async () => {
      const chatId = nextId('room');
      await seedRoom(chatId);
      const mediaPath = writeMediaFile('broken.jpg', 'payload');

      const ctx = makeCtx({
        chatId,
        isGroup: false,
        text: 'what is this?',
        hasMedia: true,
        mediaPath,
        mimeType: 'image/jpeg',
        mediaReady: Promise.reject(new Error('Simulated download failure')),
      });
      await handleIncomingMessage(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('internal error'), {});
      const calls = ctx.react.mock.calls.map(call => call[0]);
      expect(calls).toContain('❌');
    });

    test('still replies when the AI returns a non-OK HTTP status', async () => {
      global.fetch = mock(async () => new Response('Internal Server Error', { status: 500 })) as unknown as typeof global.fetch;
      const ctx = makeCtx({ isGroup: false, text: 'trigger ai error' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });

    test('falls back to the internal error message when the model returns no text', async () => {
      global.fetch = mock(async () => new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: null } }], usage: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof global.fetch;
      const ctx = makeCtx({ isGroup: false, text: 'empty response' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith('An internal error occurred while processing your message.', undefined);
    });
  });
});
