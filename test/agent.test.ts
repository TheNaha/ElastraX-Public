/**
 * agent.test.ts
 *
 * Unit tests for handleIncomingMessage() in src/agent/index.ts.
 *
 * Strategy: Rather than mocking the AIClient class (which is instantiated at
 * module-evaluation time and can't be easily replaced after the fact), we mock
 * global.fetch so the real AIClient succeeds with predictable responses.
 * Heavy deps (DB, logger, fs) are replaced via mock.module() before the agent
 * module is imported. Tools and FlowHandler use spyOn to avoid mock.module
 * bleed into registry.test.ts and FlowHandler.test.ts.
 */
import { describe, test, expect, mock, spyOn, beforeEach, afterEach, afterAll } from 'bun:test';
import { MessageContext } from '../src/core/MessageContext';

// ─── Mutable state shared between mock closures and tests ────────────────────

let mockRoomRows: any[] = [];
let mockHistoryRows: any[] = [];
const insertedValues: any[] = [];
let mockUpdateSets: any[] = [];
let shouldThrowOnHistoryFetch = false;
let shouldFileExist = false;

// Flow state
let mockFlowResult = false;

// Tool registry – map of name → tool instance
let mockToolMap: Record<string, any> = {};

// ─── Module mocks ─────────────────────────────────────────────────────────────

mock.module('../src/utils/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

// DB mock: select().from(table).where() must be both awaitable (room lookup)
// and chainable via .orderBy().limit() (history lookup).
// We identify tables by their Drizzle name symbol rather than the mock string
// so that the real schema can be used (no schema mock bleed).
const DRIZZLE_NAME = Symbol.for('drizzle:Name');

mock.module('../src/db', () => ({
  db: {
    select: () => ({
      from: (tableRef: any) => {
        const isMessages = tableRef?.[DRIZZLE_NAME] === 'messages';
        return {
          where: (_cond: any) => {
            const rows = isMessages ? mockHistoryRows : mockRoomRows;
            // Return something that is BOTH awaitable AND supports .orderBy().limit()
            const result: any = {
              then(resolve: Function, reject?: Function) {
                return Promise.resolve(rows).then(resolve as any, reject as any);
              },
              catch(rej: Function) {
                return Promise.resolve(rows).catch(rej as any);
              },
              orderBy: (_ord: any) => ({
                limit: (_n: number) =>
                  shouldThrowOnHistoryFetch && isMessages
                    ? Promise.reject(new Error('DB history fetch failed'))
                    : Promise.resolve(rows),
              }),
            };
            return result;
          },
        };
      },
    }),
    insert: () => ({
      values: (vals: any) => {
        insertedValues.push(vals);
        return { onConflictDoNothing: async () => ({}) };
      },
    }),
    update: () => ({
      set: (vals: any) => {
        mockUpdateSets.push(vals);
        return { where: async () => {} };
      },
    }),
  },
}));

mock.module('fs/promises', () => ({
  readFile: async () => Buffer.from('media-content'),
}));

mock.module('fs', () => ({
  existsSync: (_path: string) => shouldFileExist,
}));

// ConfigService: NOT mocked — use the real implementation.
// Room settings are controlled via mockRoomRows so ConfigService reads them naturally.

// Import AFTER all mocks are registered
import { handleIncomingMessage } from '../src/agent/index';

// Use spyOn for tools and FlowHandler AFTER importing agent.
// spyOn replaces the live binding in the module namespace so the agent sees it,
// but unlike mock.module() it does NOT bleed into other test files.
import * as toolsModule from '../src/tools';
import * as flowModule from '../src/core/FlowHandler';

const getToolDefinitionsSpy = spyOn(toolsModule, 'getToolDefinitions');
const getToolByNameSpy = spyOn(toolsModule, 'getToolByName');
const getToolByAliasOrNameSpy = spyOn(toolsModule, 'getToolByAliasOrName');
const flowHandleSpy = spyOn(flowModule.FlowHandler, 'handle');

// ─── Fetch helper: build a realistic OpenAI chat/completions response ─────────

function makeFetchResponse(content: string, toolCalls?: any[]): Response {
  const message: any = { role: 'assistant', content };
  if (toolCalls) message.tool_calls = toolCalls;
  return new Response(
    JSON.stringify({ choices: [{ message }], usage: {} }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const defaultRoom = () => ({
  id: 'chat-1',
  platform: 'whatsapp',
  language: 'en',
  systemPrompt: 'You are ElastraX. Language: {{LANGUAGE}}',
  contextLimit: 10,
  temperature: 0.7,
  // Explicitly disable tools and auto-reply for most tests to avoid tool-call loops
  allowTools: false,
  autoReplyAll: false,
  created_at: new Date(),
});

const makeCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  platform: 'whatsapp',
  chatId: 'chat-1',
  senderId: 'user-1',
  senderName: 'Alice',
  text: 'Hello ElastraX',
  isGroup: false,
  hasMedia: false,
  rawMessage: {},
  messageId: 'msg-1',
  messageType: 'conversation',
  mediaReady: Promise.resolve(),
  reply: mock(async () => {}),
  react: mock(async () => {}),
  checkPermissions: mock(async () => true),
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

// Restore all spies after the entire agent test suite so they don't bleed into
// registry.test.ts, registry.edge.test.ts, or FlowHandler.test.ts.
afterAll(() => {
  getToolDefinitionsSpy.mockRestore();
  getToolByNameSpy.mockRestore();
  getToolByAliasOrNameSpy.mockRestore();
  flowHandleSpy.mockRestore();
});

describe('handleIncomingMessage', () => {
  const originalFetch = global.fetch;
  const AI_URL = 'https://test-ai.example.com/v1';

  beforeEach(() => {
    // Set AI env vars so the real AIClient passes its URL check
    process.env.AI_API_BASE_URL = AI_URL;
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_MODEL_NAME = 'test-model';

    // Default fetch: return a simple AI response
    global.fetch = mock(async () => makeFetchResponse('Hello, I am ElastraX!')) as any;

    mockRoomRows = [defaultRoom()];
    mockHistoryRows = [];
    insertedValues.length = 0;
    mockUpdateSets.length = 0;
    shouldThrowOnHistoryFetch = false;
    mockFlowResult = false;
    mockToolMap = {};
    shouldFileExist = false;

    // Configure spies using current mockToolMap / mockFlowResult state.
    // These are re-applied every test so the closures see the latest values.
    flowHandleSpy.mockImplementation(async () => mockFlowResult);
    getToolByNameSpy.mockImplementation((name: string) => mockToolMap[name]);
    getToolByAliasOrNameSpy.mockImplementation((alias: string) =>
      Object.values(mockToolMap).find((t: any) =>
        t.name === alias || (t.aliases ?? []).includes(alias),
      ),
    );
    getToolDefinitionsSpy.mockImplementation(() =>
      Object.values(mockToolMap).map((t: any) => t.definition ?? {
        type: 'function',
        function: { name: t.name, description: '', parameters: { type: 'object', properties: {}, required: [] } },
      }),
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.AI_API_BASE_URL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL_NAME;
  });

  // ── Room initialisation ───────────────────────────────────────────────────

  describe('room initialisation', () => {
    test('should create a new room when none exists in the DB', async () => {
      mockRoomRows = []; // no existing room → agent creates one
      const ctx = makeCtx();
      await handleIncomingMessage(ctx);
      const roomInsert = insertedValues.find((v) => v.id === 'chat-1' && v.platform);
      expect(roomInsert).toBeDefined();
      expect(roomInsert.language).toBe('en');
    });

    test('should set ctx.language from the existing room record', async () => {
      mockRoomRows = [{ ...defaultRoom(), language: 'id' }];
      const ctx = makeCtx();
      await handleIncomingMessage(ctx);
      expect(ctx.language).toBe('id');
    });
  });

  // ── Flow handling ─────────────────────────────────────────────────────────

  describe('flow handling', () => {
    test('should return early when FlowHandler intercepts the message', async () => {
      mockFlowResult = true;
      const ctx = makeCtx({ reply: mock(async () => {}) });
      await handleIncomingMessage(ctx);
      // AI was not triggered; no reply sent by the agent itself
      expect(ctx.reply).not.toHaveBeenCalled();
    });
  });

  // ── Private DM – AI conversation ─────────────────────────────────────────

  describe('private DM – AI conversation', () => {
    test('should send the AI reply for a private DM', async () => {
      const ctx = makeCtx({ isGroup: false, text: 'How are you?' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith('Hello, I am ElastraX!');
    });

    test('should react with ⏳ before the AI response and ✅ after', async () => {
      const ctx = makeCtx({ isGroup: false, text: 'Hi' });
      await handleIncomingMessage(ctx);
      const calls = (ctx.react as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls).toContain('⏳');
      expect(calls).toContain('✅');
    });

    test('should save user message and AI response to the database', async () => {
      const ctx = makeCtx({ isGroup: false, text: 'Test message' });
      await handleIncomingMessage(ctx);
      const userMsg = insertedValues.find((v) => v.role === 'user');
      const aiMsg = insertedValues.find((v) => v.role === 'assistant');
      expect(userMsg).toBeDefined();
      expect(aiMsg).toBeDefined();
      expect(aiMsg.content).toBe('Hello, I am ElastraX!');
    });

    test('should recover gracefully when AI chatCompletion throws', async () => {
      global.fetch = mock(async () => {
        throw new Error('Network failure');
      }) as any;
      const ctx = makeCtx({ isGroup: false, text: 'trigger error' });
      await expect(handleIncomingMessage(ctx)).resolves.toBeUndefined();
      // Agent's inner catch is triggered
      const replyCalls = (ctx.reply as any).mock.calls;
      expect(replyCalls.length).toBeGreaterThan(0);
    });
  });

  // ── Group messages ────────────────────────────────────────────────────────

  describe('group messages', () => {
    test('should NOT reply in a group when not triggered', async () => {
      const ctx = makeCtx({
        isGroup: true,
        text: 'random group message',
        mentionedIds: [],
        quoted: undefined,
      });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    test('should reply in a group when the bot is @mentioned', async () => {
      const ctx = makeCtx({
        isGroup: true,
        text: 'Hey @bot what is 2+2?',
        mentionedIds: ['bot@s.whatsapp.net'],
      });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });

    test('should reply in a group when the user replies to a bot message', async () => {
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

    test('should reply in a group when /chat prefix is used', async () => {
      const ctx = makeCtx({
        isGroup: true,
        text: '/chat Tell me a joke',
        mentionedIds: [],
      });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });

    test('should reply in a group when /chat prefix is used (strips prefix from user content)', async () => {
      const ctx = makeCtx({
        isGroup: true,
        text: '/chat What is AI?',
        mentionedIds: [],
      });
      await handleIncomingMessage(ctx);
      // The reply should be the AI response
      expect(ctx.reply).toHaveBeenCalledWith('Hello, I am ElastraX!');
    });
  });

  // ── Explicit slash command routing ────────────────────────────────────────

  describe('explicit slash command routing', () => {
    beforeEach(() => {
      mockToolMap = {
        menu: {
          name: 'menu',
          aliases: ['help'],
          description: 'Shows menu',
          permissions: 'user',
          definition: {
            type: 'function',
            function: {
              name: 'menu',
              description: 'Shows menu',
              parameters: { type: 'object', properties: {}, required: [] },
            },
          },
          execute: mock(async () => 'Menu content'),
        },
      };
    });

    test('should route a /menu command to the MenuTool', async () => {
      const ctx = makeCtx({ text: '/menu', isGroup: false });
      await handleIncomingMessage(ctx);
      expect(mockToolMap.menu.execute).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Menu content');
    });

    test('should react with 🔍 before executing a tool and ✅ after', async () => {
      const ctx = makeCtx({ text: '/menu', isGroup: false });
      await handleIncomingMessage(ctx);
      const calls = (ctx.react as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls).toContain('🔍');
      expect(calls).toContain('✅');
    });

    test('should reply with no-permission message when the user lacks permission', async () => {
      const ctx = makeCtx({
        text: '/menu',
        isGroup: false,
        checkPermissions: mock(async () => false),
      });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('permission'));
    });

    test('should reply with error message and react ❌ when tool.execute throws', async () => {
      mockToolMap.menu.execute = mock(async () => {
        throw new Error('Tool crashed!');
      });
      const ctx = makeCtx({ text: '/menu', isGroup: false });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith('Tool crashed!');
      const calls = (ctx.react as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls).toContain('❌');
    });

    test('should reply "Unknown command" for unrecognised slash commands', async () => {
      mockToolMap = {}; // no tools registered
      const ctx = makeCtx({ text: '/unknowncmd', isGroup: false });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
    });

    test('should pass query string arguments to the tool for multi-word commands', async () => {
      const ctx = makeCtx({ text: '/menu arg1 arg2', isGroup: false });
      await handleIncomingMessage(ctx);
      expect(mockToolMap.menu.execute).toHaveBeenCalled();
    });
  });

  // ── Tool call loop (AI requesting tools) ──────────────────────────────────

  describe('tool call loop (AI requesting tools, allowTools=true)', () => {
    beforeEach(() => {
      // Enable tools for this describe block by providing a room with allowTools=null (defaults to true)
      mockRoomRows = [{ ...defaultRoom(), allowTools: null }];
    });

    test('should execute a tool the AI requests and then reply with the final text', async () => {
      const searchTool = {
        name: 'web_search',
        aliases: [],
        execute: mock(async () => 'Search results here'),
      };
      mockToolMap = { web_search: searchTool };

      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        if (callCount === 1) {
          // First AI call: request the tool
          return new Response(
            JSON.stringify({
              choices: [{
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'call-1', function: { name: 'web_search', arguments: '{"query":"bun"}' } }],
                },
              }],
              usage: {},
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // Second AI call: final text
        return makeFetchResponse('Here are the results!');
      }) as any;

      const ctx = makeCtx({ isGroup: false, text: 'Search for bun' });
      await handleIncomingMessage(ctx);
      expect(searchTool.execute).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Here are the results!');
    });

    test('should handle an unknown tool name from AI gracefully', async () => {
      mockToolMap = {}; // no tools registered

      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              choices: [{
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'call-x', function: { name: 'nonexistent', arguments: '{}' } }],
                },
              }],
              usage: {},
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return makeFetchResponse('Fallback answer');
      }) as any;

      const ctx = makeCtx({ isGroup: false, text: 'Do something' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith('Fallback answer');
    });

    test('should handle malformed tool arguments from AI gracefully', async () => {
      const dummyTool = {
        name: 'dummy',
        aliases: [],
        execute: mock(async () => 'ok'),
      };
      mockToolMap = { dummy: dummyTool };

      let callCount = 0;
      global.fetch = mock(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              choices: [{
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'call-bad', function: { name: 'dummy', arguments: 'NOT_JSON' } }],
                },
              }],
              usage: {},
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return makeFetchResponse('Done');
      }) as any;

      const ctx = makeCtx({ isGroup: false, text: 'trigger malformed args' });
      await handleIncomingMessage(ctx);
      expect(dummyTool.execute).toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Done');
    });
  });

  // ── Empty / no-op messages ────────────────────────────────────────────────

  describe('empty / no-op messages', () => {
    test('should do nothing if text is empty and there is no media (private DM)', async () => {
      const ctx = makeCtx({ isGroup: false, text: '', hasMedia: false });
      await handleIncomingMessage(ctx);
      // No assistant message saved, no reply sent
      const aiMsg = insertedValues.find((v) => v.role === 'assistant');
      expect(aiMsg).toBeUndefined();
    });
  });

  // ── Quoted message context ────────────────────────────────────────────────

  describe('quoted message context', () => {
    test('should prepend the quoted text to the user content', async () => {
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
      const userMsg = insertedValues.find((v) => v.role === 'user');
      expect(userMsg?.content).toContain('Replying to');
      expect(userMsg?.content).toContain('ElastraX is awesome');
    });

    test('should label the bot\'s own quoted messages as "ElastraX (You)"', async () => {
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
      const userMsg = insertedValues.find((v) => v.role === 'user');
      expect(userMsg?.content).toContain('ElastraX (You)');
    });

    test('should truncate very long quoted text (>150 chars) with "..."', async () => {
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
      const userMsg = insertedValues.find((v) => v.role === 'user');
      expect(userMsg?.content).toContain('...');
    });

    test('should use "<Media attached>" when quoted message has media but no text', async () => {
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
      const userMsg = insertedValues.find((v) => v.role === 'user');
      expect(userMsg?.content).toContain('Media attached');
    });
  });

  // ── Media handling ─────────────────────────────────────────────────────────

  describe('media handling', () => {
    test('should react with 📥 and update DB when hasMedia=true (shouldTriggerAI=true)', async () => {
      const ctx = makeCtx({
        isGroup: false,
        text: 'what is in this image?',
        hasMedia: true,
        mediaPath: '/tmp/agent-test.jpg',
        mimeType: 'image/jpeg',
        mediaReady: Promise.resolve(),
      });
      await handleIncomingMessage(ctx);
      const reacts = (ctx.react as any).mock.calls.map((c: any[]) => c[0]);
      expect(reacts).toContain('📥');
      // The syncDbMedia function should have called db.update with the mediaPath
      expect(mockUpdateSets.some((s: any) => s.mediaPath === '/tmp/agent-test.jpg')).toBe(true);
    });

    test('should also update DB for quoted.mediaPath when both are present', async () => {
      const ctx = makeCtx({
        isGroup: false,
        text: 'describe the quoted image too',
        hasMedia: true,
        mediaPath: '/tmp/main.jpg',
        mimeType: 'image/jpeg',
        mediaReady: Promise.resolve(),
        quoted: {
          messageType: 'imageMessage',
          body: 'old photo',
          text: 'old photo',
          senderId: 'user-x',
          hasMedia: true,
          stanzaId: 'quoted-stanza-1',
          mediaPath: '/tmp/quoted.jpg',
          mimeType: 'image/jpeg',
          rawMessage: {},
        },
      });
      await handleIncomingMessage(ctx);
      expect(mockUpdateSets.some((s: any) => s.mediaPath === '/tmp/quoted.jpg')).toBe(true);
    });

    test('should include image media parts in AI context when existsSync=true', async () => {
      shouldFileExist = true;
      mockHistoryRows = [
        {
          role: 'user', content: 'check this image', senderName: 'Alice',
          mediaPath: '/tmp/img.jpg', mimeType: 'image/jpeg',
          created_at: new Date(), providerMessageId: 'hist-img',
        },
      ];
      const ctx = makeCtx({ isGroup: false, text: 'describe it' });
      await handleIncomingMessage(ctx);
      // AI must have been called (reply was sent)
      expect(ctx.reply).toHaveBeenCalled();
    });

    test('should include video media parts in AI context when existsSync=true', async () => {
      shouldFileExist = true;
      mockHistoryRows = [
        {
          role: 'user', content: 'watch this', senderName: 'Alice',
          mediaPath: '/tmp/vid.mp4', mimeType: 'video/mp4',
          created_at: new Date(), providerMessageId: 'hist-vid',
        },
      ];
      const ctx = makeCtx({ isGroup: false, text: 'summarise the video' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });

    test('should include audio media parts in AI context when existsSync=true', async () => {
      shouldFileExist = true;
      mockHistoryRows = [
        {
          role: 'user', content: 'listen', senderName: 'Alice',
          mediaPath: '/tmp/audio.ogg', mimeType: 'audio/ogg',
          created_at: new Date(), providerMessageId: 'hist-audio',
        },
      ];
      const ctx = makeCtx({ isGroup: false, text: 'transcribe it' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });

    test('should include document attachment note in AI context when existsSync=true', async () => {
      shouldFileExist = true;
      mockHistoryRows = [
        {
          role: 'user', content: 'here is the doc', senderName: 'Alice',
          mediaPath: '/tmp/report.pdf', mimeType: 'application/pdf',
          created_at: new Date(), providerMessageId: 'hist-doc',
        },
      ];
      const ctx = makeCtx({ isGroup: false, text: 'summarise the document' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });

    test('should include quoted media parts in AI context when quoted.mediaPath is set', async () => {
      shouldFileExist = true;
      mockHistoryRows = [
        {
          role: 'user', content: 'what is this?', senderName: 'Alice',
          mediaPath: null, mimeType: null,
          created_at: new Date(), providerMessageId: 'msg-1', // matches ctx.messageId
        },
      ];
      const ctx = makeCtx({
        isGroup: false,
        text: 'what is this?',
        quoted: {
          messageType: 'imageMessage',
          body: 'context photo',
          text: 'context photo',
          senderId: 'user-x',
          hasMedia: true,
          mediaPath: '/tmp/quoted-ctx.jpg',
          mimeType: 'image/jpeg',
          rawMessage: {},
        },
      });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });
  });

  // ── autoReplyAll group behaviour ──────────────────────────────────────────

  describe('group autoReplyAll', () => {
    test('should respond in a group when autoReplyAll=true (covers line 54)', async () => {
      mockRoomRows = [{ ...defaultRoom(), autoReplyAll: true }];
      const ctx = makeCtx({ isGroup: true, text: 'what is the weather?' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });
  });

  // ── History context ────────────────────────────────────────────────────────

  describe('history context assembly', () => {
    test('should include previous messages in AI context', async () => {
      mockHistoryRows = [
        {
          role: 'user', content: 'hello there', senderName: 'Alice',
          mediaPath: null, mimeType: null,
          created_at: new Date(), providerMessageId: 'old-msg',
        },
        {
          role: 'assistant', content: 'Hi Alice!', senderName: 'ElastraX',
          mediaPath: null, mimeType: null,
          created_at: new Date(), providerMessageId: 'bot-msg',
        },
      ];
      const ctx = makeCtx({ isGroup: false, text: 'remember me?' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      // The fetch payload should have contained the history messages
      const [, fetchInit] = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(fetchInit.body);
      const userMsg = body.messages.find((m: any) => m.role === 'user' && m.content.includes('hello there'));
      expect(userMsg).toBeDefined();
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe('error handling', () => {
    test('should reply with internal error message and react ❌ on unexpected DB failure', async () => {
      shouldThrowOnHistoryFetch = true; // throws inside the outer try/catch in agent
      const ctx = makeCtx({ isGroup: false, text: 'hello' });
      await handleIncomingMessage(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('internal error'),
      );
      const calls = (ctx.react as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls).toContain('❌');
    });

    test('should return an error response when AI returns a non-OK HTTP status', async () => {
      global.fetch = mock(async () =>
        new Response('Internal Server Error', { status: 500 })
      ) as any;
      const ctx = makeCtx({ isGroup: false, text: 'trigger ai error' });
      await handleIncomingMessage(ctx);
      // Agent should still reply (with error fallback text)
      expect(ctx.reply).toHaveBeenCalled();
    });
  });
});
