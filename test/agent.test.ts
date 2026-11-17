import { describe, test, expect, afterEach, beforeEach, mock, spyOn } from 'bun:test';
import { desc, eq, or } from 'drizzle-orm';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../src/db';
import { chatRooms, messages } from '../src/db/schema';
import type { MessageContext } from '../src/core/MessageContext';
import { toRoomKey } from '../src/agent/roomKey';
import { createTempMediaDir } from './helpers/tempMedia';

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
import { RateLimiter } from '../src/utils/RateLimiter';

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

/**
 * Assert that `ctx.reply` was called with `text`.
 *
 * The second argument is deliberately not asserted. The agent's immediate send
 * is wrapped in `withCancellableTimeout` so a slow provider cannot outlive the
 * outbox row it is racing, which means every reply now carries an
 * `AbortSignal` in its options. The previous `undefined` assertion encoded the
 * weaker contract where an in-flight reply could not be cancelled at all.
 */
function expectReply(reply: MockFn, text: string | unknown): void {
  expect(reply).toHaveBeenCalled();
  const [actualText, options] = reply.mock.calls.at(-1) as [unknown, { signal?: AbortSignal } | undefined];
  if (typeof text === 'string') {
    expect(actualText).toBe(text);
  } else {
    expect(actualText).toEqual(text);
  }
  expect(options?.signal).toBeInstanceOf(AbortSignal);
}

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

  // ── Room initialisation ─────────────────────────────────────────────────────

  describe('room initialisation', () => {
    test('replies with an internal error when the pre-AI phase throws', async () => {
      // Role resolution runs before the AI phase's try block. A failure there used
      // to escape the handler entirely, so the user got no reply at all.
      const ctx = makeCtx({ text: 'Hello' });
      (ctx.resolveRoles as MockFn).mockImplementation(async () => {
        throw new Error('role lookup exploded');
      });

      // The user is told, and the failure still propagates: the caller records
      // the durable inbox row as failed rather than acknowledging it.
      await expect(handleIncomingMessage(ctx)).rejects.toThrow('role lookup exploded');
      // Plain send, not the durable outbox: the database may be exactly what
      // failed, and an outbox row could not be written either.
      expect(ctx.reply).toHaveBeenCalledWith('An internal error occurred while processing your message.');
    });

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
      expectReply(ctx.reply, 'Hello, I am ElastraX!');
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
      expectReply(ctx.reply, 'Hello, I am ElastraX!');
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

    /**
     * The rate limiter used to run before the trigger decision, so group chatter
     * the bot was never addressed in consumed the sender's budget and then got a
     * "rate limited" reply posted into the group.
     */
    test('does not rate-limit or reply to group chatter the bot was not addressed in', async () => {
      const senderId = 'rate-limit-untriggered@s.whatsapp.net';
      const ctx = makeCtx({
        isGroup: true,
        text: 'just talking among ourselves',
        mentionedIds: [],
        senderId,
        resolveRoles: mock(async () => ['user']),
      });
      for (let i = 0; i < 10; i++) RateLimiter.checkWithLimits(senderId, 'whatsapp', 10, 60);

      await handleIncomingMessage(ctx);

      expect(ctx.reply).not.toHaveBeenCalled();
    });

    test('still rate-limits a mention the bot would answer', async () => {
      const senderId = 'rate-limit-triggered@s.whatsapp.net';
      const ctx = makeCtx({
        isGroup: true,
        text: 'hey bot are you there?',
        mentionedIds: ['bot@s.whatsapp.net'],
        isBotMentioned: true,
        senderId,
        resolveRoles: mock(async () => ['user']),
      });
      for (let i = 0; i < 10; i++) RateLimiter.checkWithLimits(senderId, 'whatsapp', 10, 60);

      await handleIncomingMessage(ctx);

      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(String((ctx.reply as MockFn).mock.calls[0]?.[0])).toContain('Slow down');
    });

    test('strips the /chat prefix from the user content', async () => {
      const ctx = makeCtx({ isGroup: true, text: '/chat What is AI?', mentionedIds: [] });
      await handleIncomingMessage(ctx);
      expectReply(ctx.reply, 'Hello, I am ElastraX!');

      const stored = await messagesFor(ctx.chatId);
      expect(stored.find(row => row.role === 'user')?.content).toBe('What is AI?');
    });

    test('strips /chat in a direct message too', async () => {
      // The strip was gated on `isGroup`, so a DM — the one context where the AI
      // always runs — forwarded the literal marker to the model.
      const ctx = makeCtx({ isGroup: false, text: '/chat What is AI?' });
      await handleIncomingMessage(ctx);
      const stored = await messagesFor(ctx.chatId);
      expect(stored.find(row => row.role === 'user')?.content).toBe('What is AI?');
    });

    test('does not treat a command that merely starts with /chat as a /chat marker', async () => {
      // `/chatty` used to match `startsWith('/chat')`, so a group user typing it
      // got `shouldTriggerAI = true` with `ty something` as the prompt.
      const ctx = makeCtx({ isGroup: true, text: '/chatty something', mentionedIds: [] });
      await handleIncomingMessage(ctx);
      expectReply(ctx.reply, expect.stringContaining('Unknown command'));
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
      expectReply(ctx.reply, expect.any(String));
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
      expectReply(ctx.reply, 'An internal error occurred while processing your message.');
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
      expectReply(ctx.reply, 'An internal error occurred while processing your message.');
      const calls = ctx.react.mock.calls.map(call => call[0]);
      expect(calls).toContain('❌');
    });

    test('replies "Unknown command" for an unrecognised slash command', async () => {
      const ctx = makeCtx({ text: '/xyzzy_super_random_command_123', isGroup: false });
      await handleIncomingMessage(ctx);
      expectReply(ctx.reply, expect.stringContaining('Unknown command'));
    });

    test('suggests a similar command when a typo is made (/men -> /menu)', async () => {
      const ctx = makeCtx({ text: '/men', isGroup: false });
      await handleIncomingMessage(ctx);
      expectReply(ctx.reply, expect.stringContaining('Did you mean *`/menu`*'));
    });

    test('suggests a similar command based on an alias (/hlp -> /help)', async () => {
      const ctx = makeCtx({ text: '/hlp', isGroup: false });
      await handleIncomingMessage(ctx);
      expectReply(ctx.reply, expect.stringContaining('Did you mean *`/help`*'));
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
    function registerTools(...tools: BaseTool[]): void {
      const map = new Map(tools.map(t => [t.name, t]));
      stubRegistry('getToolByName', (name: string) => map.get(name));
      stubRegistry('getToolsForContext', () => tools);
      stubRegistry('getAlwaysLoadedDefinitions', () => tools.map(t => t.definition));
      stubRegistry('getTriggeredTools', () => []);
      stubRegistry('getToolDefinitions', () => tools.map(t => t.definition));
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
      expectReply(ctx.reply, 'Here are the results!');
    });

    test('makes a final text-only call when the tool budget is exhausted', async () => {
      // Every iteration up to the budget may run tools. A turn that legitimately
      // used all of them ended with `isDone === false` and the accumulated answer
      // was replaced by "An internal error occurred".
      process.env.AI_MAX_TOOL_ITERATIONS = '1';
      process.env.AI_STREAMING = 'false';
      const execute = mock(async () => 'Search results here');
      registerTool(new FakeTool('web_search', execute));

      const bodies: string[] = [];
      let callCount = 0;
      global.fetch = mock(async (_url: unknown, init?: { body?: string }) => {
        callCount++;
        if (init?.body) bodies.push(init.body);
        if (callCount === 1) {
          return makeToolCallResponse([{ id: 'call-budget', name: 'web_search', args: '{"query":"bun"}' }]);
        }
        return makeFetchResponse('Answer after the budget ran out.');
      }) as unknown as typeof global.fetch;

      const ctx = makeCtx({ isGroup: false, text: 'Search for bun' });
      await handleIncomingMessage(ctx);

      expect(execute).toHaveBeenCalledTimes(1);
      expect(callCount).toBe(2);
      expectReply(ctx.reply, 'Answer after the budget ran out.');
      // The extra round must not offer tools again, or the model could loop.
      const finalRequest = JSON.parse(bodies[1]!) as { tools?: unknown[] };
      expect(finalRequest.tools).toBeUndefined();
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
      expectReply(ctx.reply, 'Fallback answer');
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
      expectReply(ctx.reply, 'Done');

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
      expectReply(ctx.reply, 'Denied');
    });

    test('times out AI-requested tools and falls back with an error response', async () => {
      process.env.AI_TOOL_TIMEOUT_MS = '10';
      const execute = mock(() => new Promise<string>(() => {}));
      registerTool(new FakeTool('web_search', execute));

      global.fetch = mock(async () => makeToolCallResponse([{ id: 'call-timeout', name: 'web_search', args: '{"query":"bun"}' }])) as unknown as typeof global.fetch;

      const ctx = makeCtx({ isGroup: false, text: 'Search for bun' });
      await handleIncomingMessage(ctx);

      expect(execute).toHaveBeenCalled();
      expectReply(ctx.reply, expect.stringContaining('An internal error occurred'));
    });

    test('appends live tool progress across multiple tools in one turn and delivers final answer in a separate message', async () => {
      process.env.AI_STREAMING = 'false';
      const execSearch = mock(async () => 'Search results for Arsenal');
      const execScrape = mock(async () => 'Match report content');
      registerTools(
        new FakeTool('web_search', execSearch),
        new FakeTool('web_scrape', execScrape),
      );

      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        if (callCount === 1) {
          return makeToolCallResponse([
            { id: 'call-1', name: 'web_search', args: JSON.stringify({ query: 'Arsenal match score yesterday' }) },
            { id: 'call-2', name: 'web_scrape', args: JSON.stringify({ query: 'match summary' }) },
          ]);
        }
        return makeFetchResponse('Arsenal won 2-0.');
      }) as unknown as typeof global.fetch;

      const sentMessages: string[] = [];
      const editedMessages: Array<{ key: unknown; text: string }> = [];
      const statusKey = { id: 'status-msg-1' };

      const ctx = makeCtx({
        isGroup: false,
        text: 'What was the score in the Arsenal match yesterday?',
        sendMessage: mock(async (text: string) => {
          sentMessages.push(text);
          return statusKey;
        }),
        editMessage: mock(async (key: unknown, text: string) => {
          editedMessages.push({ key, text });
        }),
      });

      await handleIncomingMessage(ctx);

      expect(execSearch).toHaveBeenCalled();
      expect(execScrape).toHaveBeenCalled();
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toBe('⏳ [1/2] 🔍 Searching web for "Arsenal match score yesterday"...');

      expect(editedMessages.length).toBeGreaterThanOrEqual(2);
      expect(editedMessages[0]?.key).toEqual(statusKey);
      expect(editedMessages[0]?.text).toBe(
        '✅ [1/2] 🔍 Searching web for "Arsenal match score yesterday"...\n⏳ [2/2] 📄 Reading match summary...',
      );
      expect(editedMessages.at(-1)?.key).toEqual(statusKey);
      expect(editedMessages.at(-1)?.text).toBe(
        '✅ [1/2] 🔍 Searching web for "Arsenal match score yesterday"...\n✅ [2/2] 📄 Reading match summary...',
      );

      // Final answer delivered via ctx.reply in another message block
      expectReply(ctx.reply, 'Arsenal won 2-0.');
    });

    test('dynamically updates step counter denominator across multi-turn sequential tool calls', async () => {
      process.env.AI_STREAMING = 'false';
      const execSearch = mock(async () => 'Search results');
      const execScrape = mock(async () => 'Scrape results');
      registerTools(
        new FakeTool('web_search', execSearch),
        new FakeTool('web_scrape', execScrape),
      );

      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        if (callCount === 1) {
          return makeToolCallResponse([{ id: 'call-1', name: 'web_search', args: JSON.stringify({ query: 'step1' }) }]);
        }
        if (callCount === 2) {
          return makeToolCallResponse([{ id: 'call-2', name: 'web_scrape', args: JSON.stringify({ query: 'step2' }) }]);
        }
        return makeFetchResponse('Final combined answer.');
      }) as unknown as typeof global.fetch;

      const sentMessages: string[] = [];
      const editedMessages: Array<{ key: unknown; text: string }> = [];
      const statusKey = { id: 'status-seq-1' };

      const ctx = makeCtx({
        isGroup: false,
        text: 'Do step 1 then step 2',
        sendMessage: mock(async (text: string) => {
          sentMessages.push(text);
          return statusKey;
        }),
        editMessage: mock(async (key: unknown, text: string) => {
          editedMessages.push({ key, text });
        }),
      });

      await handleIncomingMessage(ctx);

      expect(execSearch).toHaveBeenCalled();
      expect(execScrape).toHaveBeenCalled();

      // Turn 1 initially rendered [1/1]
      expect(sentMessages[0]).toBe('⏳ [1/1] 🔍 Searching web for "step1"...');

      // Later turn 2 expanded denominator to [1/2] and [2/2]
      const finalEdit = editedMessages.at(-1)?.text;
      expect(finalEdit).toBe(
        '✅ [1/2] 🔍 Searching web for "step1"...\n✅ [2/2] 📄 Reading step2...',
      );

      // Final answer delivered via ctx.reply in another message block
      expectReply(ctx.reply, 'Final combined answer.');
    });

    test('updates tool progress icon to ❌ when a tool execution fails', async () => {
      process.env.AI_STREAMING = 'false';
      const execFailing = mock(async () => {
        throw new Error('Connection refused');
      });
      registerTool(new FakeTool('web_search', execFailing));

      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        if (callCount === 1) {
          return makeToolCallResponse([{ id: 'call-fail', name: 'web_search', args: JSON.stringify({ query: 'fail' }) }]);
        }
        return makeFetchResponse('Recovered answer after tool failure.');
      }) as unknown as typeof global.fetch;

      const editedMessages: Array<{ key: unknown; text: string }> = [];
      const statusKey = { id: 'status-fail-1' };

      const ctx = makeCtx({
        isGroup: false,
        text: 'Trigger failing tool',
        sendMessage: mock(async () => statusKey),
        editMessage: mock(async (key: unknown, text: string) => {
          editedMessages.push({ key, text });
        }),
      });

      await handleIncomingMessage(ctx);

      expect(execFailing).toHaveBeenCalled();
      const finalEdit = editedMessages.at(-1)?.text;
      expect(finalEdit).toBe('❌ [1/1] 🔍 Searching web for "fail"...');
      expectReply(ctx.reply, 'Recovered answer after tool failure.');
    });

    test('renders live tool progress during streaming mode and delivers final answer in a separate message', async () => {
      process.env.AI_STREAMING = 'true';
      const execSearch = mock(async () => 'Search results for bun');
      registerTool(new FakeTool('web_search', execSearch));

      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response([
            'data: {"id":"s","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-stream-1","type":"function","function":{"name":"web_search","arguments":"{\\"query\\":\\"bun\\"}"}}]},"finish_reason":null}]}',
            '',
            'data: {"id":"s","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return new Response([
          'data: {"id":"s","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"Bun is fast."},"finish_reason":null}]}',
          '',
          'data: {"id":"s","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }) as unknown as typeof global.fetch;

      const sentMessages: string[] = [];
      const editedMessages: Array<{ key: unknown; text: string }> = [];
      let sentKeyCounter = 0;

      const ctx = makeCtx({
        isGroup: false,
        text: 'Stream bun search',
        sendMessage: mock(async (text: string) => {
          sentMessages.push(text);
          return { id: `key-${++sentKeyCounter}` };
        }),
        editMessage: mock(async (key: unknown, text: string) => {
          editedMessages.push({ key, text });
        }),
      });

      await handleIncomingMessage(ctx);

      expect(execSearch).toHaveBeenCalled();
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);
      expect(sentMessages[0]).toBe('⏳ [1/1] 🔍 Searching web for "bun"...');
      expect(editedMessages.some(e => e.text.includes('✅ [1/1] 🔍 Searching web for "bun"...'))).toBe(true);
    });

    test('never renders chain-of-thought while a think block is still streaming', async () => {
      process.env.AI_STREAMING = 'true';
      const OPEN = '<' + 'think>';
      const CLOSE = '<' + '/think>';
      const chunk = (text: string, finish: string | null = null): string =>
        `data: ${JSON.stringify({
          id: 's', object: 'chat.completion.chunk', created: 1, model: 'm',
          choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
        })}\n\n`;

      global.fetch = mock(async () => new Response(
        [
          chunk(`${OPEN}secret step one `),
          chunk('secret step two'),
          chunk(`${CLOSE}Visible answer.`, 'stop'),
          'data: [DONE]',
          '',
        ].join('\n'),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof global.fetch;

      const sent: string[] = [];
      const edited: string[] = [];
      const ctx = makeCtx({
        isGroup: false,
        text: 'Think then answer',
        sendMessage: mock(async (text: string) => {
          sent.push(text);
          return { id: 'think-key-1' };
        }),
        editMessage: mock(async (_key: unknown, text: string) => {
          edited.push(text);
        }),
      });

      await handleIncomingMessage(ctx);

      // Nothing is sent while only reasoning has arrived, and no render ever
      // contains the reasoning text.
      for (const text of [...sent, ...edited]) {
        expect(text).not.toContain('secret step');
        expect(text).not.toContain(OPEN);
      }
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every(text => text.includes('Visible answer.'))).toBe(true);
    });

    /**
     * `editMessage` grows a message by re-editing its head and posting the
     * remainder as *new* messages, so a preview past the platform limit re-posts
     * the whole tail on every edit. The preview is frozen instead; the final edit
     * still carries the complete answer (head plus one continuation).
     */
    test('freezes the streaming preview below the platform limit and still delivers the full text', async () => {
      process.env.AI_STREAMING = 'true';
      const body = `${'a'.repeat(2_400)}TAILMARKER${'b'.repeat(200)}`;
      const chunk = (text: string, finish: string | null = null): string =>
        `data: ${JSON.stringify({
          id: 's', object: 'chat.completion.chunk', created: 1, model: 'm',
          choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
        })}\n\n`;

      global.fetch = mock(async () => new Response(
        [chunk(body, 'stop'), 'data: [DONE]', ''].join('\n'),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof global.fetch;

      const sent: string[] = [];
      const edited: string[] = [];
      const ctx = makeCtx({
        isGroup: false,
        text: 'Give me a long answer',
        sendMessage: mock(async (text: string) => {
          sent.push(text);
          return { id: 'long-stream-key' };
        }),
        editMessage: mock(async (_key: unknown, text: string) => {
          edited.push(text);
        }),
      });

      await handleIncomingMessage(ctx);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('…');
      expect(sent[0]).not.toContain('TAILMARKER');
      expect(Array.from(sent[0]!).length).toBeLessThanOrEqual(1_803);

      // The final edit replaces the cursor with the complete answer.
      expect(edited.at(-1)).toContain('TAILMARKER');
      expect(edited.at(-1)).toBe(body);
    });

    test('finalises a streamed bubble that the progress tracker did not adopt', async () => {
      process.env.AI_STREAMING = 'true';
      const execSearch = mock(async () => 'Search results for bun');
      registerTool(new FakeTool('web_search', execSearch));

      const contentChunk = (text: string): string =>
        `data: ${JSON.stringify({
          id: 's', object: 'chat.completion.chunk', created: 1, model: 'm',
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\n`;
      const toolCallChunk = (id: string): string =>
        `data: ${JSON.stringify({
          id: 's', object: 'chat.completion.chunk', created: 1, model: 'm',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id,
                type: 'function',
                function: { name: 'web_search', arguments: '{"query":"bun"}' },
              }],
            },
            finish_reason: null,
          }],
        })}\n\ndata: [DONE]\n\n`;
      const textOnlyChunk = (text: string): string =>
        `${contentChunk(text)}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`;

      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        const body = callCount === 1
          ? `${contentChunk('Checking. ')}${toolCallChunk('call-1')}`
          : callCount === 2
            ? `${contentChunk('Still checking. ')}${toolCallChunk('call-2')}`
            : textOnlyChunk('Bun is fast.');
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }) as unknown as typeof global.fetch;

      const sentMessages: Array<{ text: string; key: { id: string } }> = [];
      const editedMessages: Array<{ key: unknown; text: string }> = [];
      let sentKeyCounter = 0;

      const ctx = makeCtx({
        isGroup: false,
        text: 'Stream two searches',
        sendMessage: mock(async (text: string) => {
          const key = { id: `key-${++sentKeyCounter}` };
          sentMessages.push({ text, key });
          return key;
        }),
        editMessage: mock(async (key: unknown, text: string) => {
          editedMessages.push({ key, text });
        }),
      });

      await handleIncomingMessage(ctx);

      expect(execSearch).toHaveBeenCalled();
      // The second streamed bubble is not adopted by the tracker (it already owns
      // the first), so it must be finalised without the cursor.
      const secondBubble = sentMessages.find(entry => entry.key.id === 'key-2');
      if (!secondBubble) throw new Error('expected a second streamed bubble');
      expect(secondBubble.text).toContain('▌');
      const finalised = editedMessages.find(
        entry => (entry.key as { id?: string } | null)?.id === 'key-2' && entry.text.includes('Still checking.'),
      );
      expect(finalised).toBeDefined();
      expect(finalised?.text).not.toContain('▌');
    });

    test('delivers the full answer when the final streaming edit fails', async () => {
      process.env.AI_STREAMING = 'true';
      global.fetch = mock(async () => new Response([
        'data: {"id":"s","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"Bun is fast."},"finish_reason":null}]}',
        '',
        'data: {"id":"s","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof global.fetch;

      const sentMessages: string[] = [];
      const ctx = makeCtx({
        isGroup: false,
        text: 'Stream a short answer',
        // The initial live send succeeds, so the turn looks delivered; every
        // edit (including the final one that removes the cursor) fails.
        sendMessage: mock(async (text: string) => {
          sentMessages.push(text);
          return { id: 'stream-key-1' };
        }),
        editMessage: mock(async () => {
          throw new Error('editing not supported');
        }),
      });

      await handleIncomingMessage(ctx);

      // A partial streamed message was sent, then the complete answer follows as
      // a normal reply — the user must never be left on the truncated text.
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);
      expectReply(ctx.reply, 'Bun is fast.');
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

    /**
     * The "quoted attachment omitted" note used to replace the whole content with
     * a plain string, which threw away an image embedded for the *current*
     * message: sending a photo as a reply to another photo meant the model only
     * saw text.
     */
    test('keeps the current message image when the message also quotes media', async () => {
      // A real 1x1 PNG: inlining is only attempted for an image whose dimensions
      // can be read from its header.
      const currentPath = join(mediaDir, `${RUN_TOKEN}-current.png`);
      writeFileSync(currentPath, Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ));
      const capturedBodies: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
      global.fetch = mock(async (_url: unknown, init?: { body?: unknown }) => {
        capturedBodies.push(JSON.parse(String(init?.body)) as (typeof capturedBodies)[number]);
        return makeFetchResponse('Nice picture.');
      }) as unknown as typeof global.fetch;

      const ctx = makeCtx({
        isGroup: false,
        text: 'what is different here?',
        hasMedia: true,
        mediaPath: currentPath,
        mimeType: 'image/png',
        mediaReady: Promise.resolve(),
        quoted: {
          messageType: 'imageMessage',
          body: 'old photo',
          text: 'old photo',
          senderId: 'user-x',
          hasMedia: true,
          mediaPath: join(mediaDir, `${RUN_TOKEN}-quoted-old.png`),
          mimeType: 'image/png',
          rawMessage: { key: { fromMe: false } },
        },
      });

      await handleIncomingMessage(ctx);

      const mediaTurn = capturedBodies
        .flatMap(body => body.messages ?? [])
        .find(message => message.role === 'user' && Array.isArray(message.content));
      expect(mediaTurn).toBeDefined();
      const parts = mediaTurn!.content as Array<{ type: string; text?: string }>;
      expect(parts.some(part => part.type === 'image_url')).toBe(true);
      expect(parts.some(part => part.type === 'text' && part.text?.includes('Quoted attachment omitted'))).toBe(true);
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

      expectReply(ctx.reply, expect.stringContaining('internal error'));
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
      expectReply(ctx.reply, 'An internal error occurred while processing your message.');
    });
  });
});
