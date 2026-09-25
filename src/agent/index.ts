/**
 * @file src/agent/index.ts
 * @description Core conversational agent for ElastraX.
 *
 * This module exports `handleIncomingMessage`, which is the single entry point
 * wired to every messaging platform provider (WhatsApp, Discord, etc.).
 *
 * High-level processing pipeline for each incoming message:
 *  1. Fetch or create the ChatRoom record in the database; resolve per-room config.
 *  2. Determine whether the AI should generate a reply (`shouldTriggerAI`).
 *     - Private chats: always reply.
 *     - Group chats: reply only when the bot is mentioned, replied-to, or
 *       `autoReplyAll` is enabled, or the message starts with `/chat`.
 *  3. Intercept active interactive flows (multi-step wizards) via FlowHandler.
 *  4. Handle explicit slash commands (e.g., `/search <query>`) by routing them
 *     directly to the matching BaseTool — no LLM involved.
 *  5. For conversational messages, save the user message to the database,
 *     await media downloads, build the full context window, and run the
 *     LLM inference loop (which may invoke tools recursively, with streaming
 *     support when enabled).
 *  6. Persist the final assistant reply and send it back to the user.
 *
 * V7.10 additions:
 *  - Typed LLM interfaces (ChatCompletionMessage, ToolCall)
 *  - Streaming responses with rate-limited message editing
 *  - Conversation branching (smart quoted-message context loading)
 *  - Health metrics integration
 *  - Typing indicators
 */

import { db } from '../db';
import { chatRooms, messages, memories } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { MessageContext } from '../core/MessageContext';
import { AIChatMessage, StreamingToolCallAccumulator } from '../ai/client';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import {
  getToolByName,
  getAuthorizedTool,
  getAlwaysLoadedDefinitions,
  getToolDefinitions,
  getTriggeredTools,
  getToolsForContext,
  toolSearchIndex,
  executeAuthorizedCommand,
  validateToolArguments,
} from '../tools';

const log = logger.child({ module: 'Agent' });
import { FlowHandler } from '../core/FlowHandler';
import { MAX_INJECTED_MEMORIES, UNLIMITED } from '../core/constants';
import { t } from '../utils/i18n';
import { levenshtein } from '../utils/similarity';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { ConfigService } from '../utils/ConfigService';
import { getModelRouter } from '../utils/ModelRouter';
import { rankMemoriesForInjection } from '../utils/semanticMemory';
import { RateLimiter } from '../utils/RateLimiter';
import { AuthService } from '../utils/AuthService';
import { createPersistentSummaryService } from '../ai/summaryStore';
import { createTurnBudget, type TurnBudget } from '../ai/turnBudget';
import type { ChatCompletionMessage, ToolCall, ModelTier } from '../types/ai';
import type { BaseTool, ToolArgs, ToolResult, ToolDefinition } from '../tools/BaseTool';
import { healthMetrics } from '../utils/HealthMetrics';
import { getMaxToolIterations, getStreamingConfig, getToolLoadingMode, getToolTimeoutMs as getConfiguredToolTimeoutMs, getTurnBudgetConfig } from '../config/runtime';
import { isAudioMimeType, isTranscriptionConfigured, resolveTranscriptionSource, transcribeSource } from '../utils/transcription';
import { withCancellableTimeout } from '../utils/withTimeout.js';
import { sanitizeRawMessage } from '../utils/rawMessage';
import { OutboxService } from '../messaging/OutboxService';
import { getInlineMediaEligibility } from '../providers/media';

const modelRouter = getModelRouter();
const persistentSummaryService = createPersistentSummaryService();

function getToolTimeoutMs(): number {
  return getConfiguredToolTimeoutMs();
}

function getAllowedTools(roles: string[], isGroup: boolean, platform = 'whatsapp'): BaseTool[] {
  return getToolsForContext({
    roles,
    isGroup,
    platform,
    isOwner: roles.includes('owner'),
  });
}

function resolveToolResultText(result: ToolResult): string {
  return typeof result === 'object' && result !== null && 'text' in result
    ? result.text
    : result;
}

async function deliverDurableText(ctx: MessageContext, text: string, source: string, mentions?: string[]): Promise<void> {
  if (!text.trim()) return;
  const deliveryId = OutboxService.enqueueText(
    ctx.platform,
    ctx.chatId,
    text,
    [ctx.messageId, source],
  );
  try {
    const replyOptions = {
      ...(mentions?.length ? { mentions } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    };
    const result = await ctx.reply(text, replyOptions);
    OutboxService.markEnqueuedSent(deliveryId, typeof result === 'string' ? result : null);
  } catch (error) {
    log.warn({ err: error, deliveryId, source }, 'Immediate delivery failed; outbox will retry');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolArgs(rawArgs: string, toolName: string, logMalformed: boolean): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawArgs || '{}');
    if (isRecord(parsed)) return parsed;
    if (logMalformed) log.warn({ toolName }, 'Tool arguments must be a JSON object');
    return null;
  } catch {
    if (logMalformed) log.warn({ toolName }, 'Failed to parse tool arguments');
    return null;
  }
}

function discoverMatchingTools(
  query: string,
  allowedToolNames: Set<string>,
  dynamicToolNames: Set<string>,
  availableTools: ToolDefinition[] | undefined,
): string[] {
  const discovered = toolSearchIndex.search(query, 7);
  const added: string[] = [];

  for (const entry of discovered) {
    if (!allowedToolNames.has(entry.name) || dynamicToolNames.has(entry.name)) {
      continue;
    }

    dynamicToolNames.add(entry.name);
    added.push(entry.name);
    if (availableTools && !availableTools.some((definition) => definition.function.name === entry.name)) {
      availableTools.push(entry.tool.definition);
    }
  }

  return added;
}

async function executeRequestedToolCalls(
  toolCalls: ToolCall[],
  options: {
    ctx: MessageContext;
    chatId: string;
    iteration: number;
    allowedToolNames: Set<string>;
    dynamicToolNames: Set<string>;
    availableTools: ToolDefinition[] | undefined;
    toolLoadingMode: 'all' | 'search';
    preferredTier?: ModelTier;
    logMalformedArgs: boolean;
    turnBudget: TurnBudget;
    mode?: 'stream';
  },
): Promise<{ toolResults: Array<{ role: 'tool'; tool_call_id: string; name: string; content: string }>; preferredTier?: ModelTier }> {
  options.turnBudget.claimToolCalls(toolCalls.length);

  const toolResults: Array<{ role: 'tool'; tool_call_id: string; name: string; content: string }> = [];
  let preferredTier = options.preferredTier;

  for (const toolCall of toolCalls) {
    const toolName = toolCall.function.name;
    const tool = getToolByName(toolName);
    let toolResultText = '';
    let resultTier: ModelTier | undefined;

    if (!tool) {
      toolResultText = `Error: Tool ${toolName} not found.`;
      log.error({ toolName, chatId: options.chatId }, 'LLM requested unknown tool');
    } else if (!(options.allowedToolNames.has(tool.name) || options.dynamicToolNames.has(tool.name))) {
      toolResultText = `Error: You do not have permission to use tool ${toolName}.`;
      log.warn({ toolName, chatId: options.chatId, senderId: options.ctx.senderId }, 'LLM requested unauthorized tool');
    } else {
      const args = parseToolArgs(toolCall.function.arguments, toolName, options.logMalformedArgs);
      if (!args) {
        toolResultText = `Error: Arguments for ${toolName} must be a valid JSON object.`;
      } else {
        const validation = validateToolArguments(tool, args);
        if (!validation.valid || !isRecord(validation.value)) {
          toolResultText = `Error: Invalid arguments for ${toolName}: ${validation.errors.join('; ')}`;
        } else {
          const validArgs = validation.value;
          log.info(
            { toolName, chatId: options.chatId, iteration: options.iteration, ...(options.mode ? { mode: options.mode } : {}) },
            'Tool call invoked',
          );
          healthMetrics.recordToolInvocation(toolName);
          await options.ctx.react?.('🔧').catch(() => {});
          try {
            const rawResult = await executeToolWithTimeout(tool, validArgs, options.ctx);
            toolResultText = options.turnBudget.constrainTextResult(resolveToolResultText(rawResult)).value;
            resultTier = tool.modelTier;
          } catch (err: unknown) {
            log.error({ err, toolName, chatId: options.chatId }, 'Tool execution failed or timed out');
            toolResultText = options.turnBudget.constrainTextResult(
              `Error executing tool ${toolName}: ${getErrorMessage(err)}`,
            ).value;
          }

          if (toolName === 'find_tools' && options.toolLoadingMode === 'search') {
            const query = typeof validArgs.query === 'string' ? validArgs.query : '';
            const discovered = discoverMatchingTools(
              query,
              options.allowedToolNames,
              options.dynamicToolNames,
              options.availableTools,
            );
            log.info({ chatId: options.chatId, discovered }, '[Agent] Tools discovered via find_tools');
          }
        }
      }
    }

    if (resultTier && !preferredTier) preferredTier = resultTier;
    toolResults.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      name: toolName,
      content: toolResultText,
    });
  }

  return { toolResults, preferredTier };
}

function stripThinkTags(text: string): string {
  // Remove one or more <think>…</think> blocks (greedy, dotall via [\s\S])
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function extractAssistantText(aiMsgObj: ChatCompletionMessage): string {
  // Keep content as unknown because some providers may return non-spec formats
  // (e.g., array-of-parts) even though the typed interface expects string|null.
  const content: unknown = aiMsgObj?.content;

  if (typeof content === 'string') {
    return stripThinkTags(content);
  }

  if (Array.isArray(content)) {
    // ⚡ Bolt: Use a single for...of loop instead of chaining .map().filter().join()
    // to prevent allocating intermediate arrays and reduce GC pressure during message parsing.
    let text = '';
    for (const part of content) {
      if (typeof part === 'string' && part) {
        text += (text ? '\n' : '') + part;
      } else if (
        typeof part === 'object' &&
        part !== null &&
        'text' in part &&
        typeof (part as { text?: unknown }).text === 'string' &&
        (part as { text: string }).text
      ) {
        text += (text ? '\n' : '') + (part as { text: string }).text;
      }
    }
    text = text.trim();
    if (text) return stripThinkTags(text);
  }

  if (typeof aiMsgObj?.refusal === 'string' && aiMsgObj.refusal.trim()) {
    return stripThinkTags(aiMsgObj.refusal);
  }

  if (typeof aiMsgObj?.output_text === 'string' && aiMsgObj.output_text.trim()) {
    return stripThinkTags(aiMsgObj.output_text);
  }

  return '';
}

async function executeToolWithTimeout(
  tool: BaseTool,
  args: ToolArgs,
  ctx: MessageContext,
): Promise<ToolResult> {
  const startMs = Date.now();
  const timeoutMs = getToolTimeoutMs();

  try {
    const result = await withCancellableTimeout(
      signal => tool.execute(args, ctx, signal),
      timeoutMs,
      `Tool ${tool.name}`,
      ctx.signal,
    );
    healthMetrics.recordToolDuration(tool.name, Date.now() - startMs);
    return result;
  } catch (err: unknown) {
    healthMetrics.recordToolError(tool.name);
    healthMetrics.recordToolDuration(tool.name, Date.now() - startMs);
    throw err;
  }
}

async function transcribeVoiceIfAny(ctx: MessageContext): Promise<string | null> {
  if (!isTranscriptionConfigured()) return null;
  await ctx.mediaReady;
  if (!isAudioMimeType(ctx.mimeType)) return null;

  try {
    const source = await resolveTranscriptionSource(ctx, false);
    if (!source) return null;
    return await transcribeSource(source, ctx.language || 'en');
  } catch (err: unknown) {
    log.warn({ err }, '[Transcription] Failed to transcribe voice note');
    return null;
  }
}


/**
 * Primary handler invoked for every incoming message on every connected platform.
 *
 * All routing decisions (group vs DM, command vs AI, flow vs normal) are made here.
 * Platform-specific details are fully abstracted by the `MessageContext` interface.
 *
 * @param ctx - Normalised message context provided by the active BotProvider.
 */
export async function handleIncomingMessage(ctx: MessageContext): Promise<void> {
  const startMs = Date.now();
  const { chatId, platform, senderName, text, isGroup } = ctx;
  const verboseAiLogs = process.env.AI_VERBOSE_LOGS === 'true';

  // Fetch or create the chat room early so that ctx.language is available to all
  // tools and flow handlers before any routing takes place.
  let room = (await db.select().from(chatRooms).where(eq(chatRooms.id, chatId)))[0];
  if (room && room.platform !== platform) {
    throw new Error(`Room ID collision between ${room.platform} and ${platform}`);
  }
  if (!room) {
    const defaults = ConfigService.getDefaults(isGroup);
    log.info({ chatId, platform }, 'New chat room created');
    const newRoom: typeof chatRooms.$inferInsert = {
      id: chatId,
      platform,
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
    await db.insert(chatRooms).values(newRoom).onConflictDoNothing();
    room = (await db.select().from(chatRooms).where(eq(chatRooms.id, chatId)))[0] ?? {
      ...newRoom,
      id: chatId,
      created_at: newRoom.created_at ?? new Date(),
    };
  }
  ctx.language = room.language;

  // V7.11: Resolve user roles once and compute privilege-based rate limits.
  const { roles: userRoles, privileges } = await AuthService.getAccessProfile(await ctx.resolveRoles());

  logger.debug(
    { senderId: ctx.senderId, senderPn: ctx.senderPn, chatId: ctx.chatId, userRoles, privileges },
    '[Agent] Role & privilege resolution complete',
  );

  // Rate limit based on the user's merged privileges (-1 = unlimited → skip).
  if (privileges.maxMessagesPerWindow !== -1) {
    const rl = RateLimiter.checkWithLimits(
      ctx.senderId,
      platform,
      privileges.maxMessagesPerWindow,
      privileges.rateLimitWindowSec,
    );
    if (!rl.allowed) {
      logger.info(
        { senderId: ctx.senderId, waitSeconds: rl.waitSeconds, limit: privileges.maxMessagesPerWindow },
        '[Agent] Rate limited — rejecting message',
      );
      await ctx.reply(t(ctx.language, 'agent.rate_limited', { seconds: String(rl.waitSeconds || 1) }));
      return;
    }
  }

  // Resolve dynamic configurations for this room
  const config = ConfigService.getResolvedConfig(room, ctx.isGroup);

  // We will always process the message to save it to context history
  // But we use this flag to decide if the AI should actually generate a reply
  let shouldTriggerAI = !isGroup;

  if (isGroup) {
    // If the room has auto-reply all enabled, the bot treats it like a DM
    if (config.autoReplyAll) {
      shouldTriggerAI = true;
    }

    if (text.startsWith('/chat') || text.startsWith('/')) {
      shouldTriggerAI = true;
    }
    // Check if the bot was explicitly mentioned using its ID.
    if (ctx.isBotMentioned) {
      shouldTriggerAI = true;
    }
    // Check if the user is replying to a message originally sent by the bot
    if (ctx.quoted?.rawMessage?.key?.fromMe) {
      shouldTriggerAI = true;
    }
  }

  // Handle active interactive sessions (bypass normal commands and AI)
  const inFlow = await FlowHandler.handle(ctx);
  if (inFlow) return;

  // Handle explicit commands (bypass AI conversation loop)
  if (text.startsWith('/') && !text.toLowerCase().startsWith('/chat')) {
    const spaceIdx = text.indexOf(' ');
    const command = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
    const queryStr = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

    log.info({ command, hasArguments: queryStr.length > 0, chatId }, 'Slash command received');

    // Map explicit commands through the shared authorization, grammar, validation,
    // mutation-admission, and execution pipeline.
    const tool = await getAuthorizedTool(command, ctx);
    if (tool) {
      await ctx.react?.('🔧').catch(() => {});
      try {
        const result = await executeAuthorizedCommand(command, queryStr, ctx);
        if (result === undefined) throw new Error('Command access denied');
        log.debug({ command, toolName: tool.name }, 'Executing slash command');
        if (typeof result === 'object' && result !== null && 'text' in result) {
          await deliverDurableText(ctx, result.text, `command:${command}`, result.mentions);
        } else {
          await deliverDurableText(ctx, String(result), `command:${command}`);
        }
        await ctx.react?.('✅').catch(() => {});
        log.debug({ command, toolName: tool.name }, 'Slash command completed');
      } catch (err: unknown) {
        log.error({ err, command, toolName: tool.name }, 'Slash command execution failed');
        await deliverDurableText(ctx, t(ctx.language, 'agent.internal_error'), `command:${command}:error`);
        await ctx.react?.('❌').catch(() => {});
      }
      return;
    }

    // If an unknown command is issued, warn the user in their language
    log.debug({ command, chatId }, 'Unknown command attempted');

    // Attempt to find a similar command (Did you mean...?)
    let suggestion: string | null = null;
    let bestDistance = Infinity;

    for (const tool of getAllowedTools(userRoles, isGroup, platform)) {
      // Check tool name
      const nameDist = levenshtein(command, tool.name);
      if (nameDist <= 3 && nameDist < bestDistance) {
        bestDistance = nameDist;
        suggestion = tool.name;
      }
      // Check aliases
      for (const alias of tool.aliases) {
        const aliasDist = levenshtein(command, alias);
        if (aliasDist <= 3 && aliasDist < bestDistance) {
          bestDistance = aliasDist;
          suggestion = alias;
        }
      }
    }

    if (suggestion) {
      await deliverDurableText(ctx, t(ctx.language, 'agent.did_you_mean', { cmd: command, suggestion }), 'command:unknown');
    } else {
      await deliverDurableText(ctx, t(ctx.language, 'agent.unknown_command', { cmd: command }), 'command:unknown');
    }
    return;
  }

  // Clean the text for conversational flow
  let userContent = isGroup && text.toLowerCase().startsWith('/chat') 
    ? text.substring(5).trim() 
    : text;

  // Emphasize quoted context by prepending it directly to the user's message payload
  if (ctx.quoted) {
    const isFromBot = ctx.quoted.rawMessage?.key?.fromMe;
    const quoteSender = isFromBot ? 'ElastraX (You)' : ctx.quoted.senderId.split('@')[0];
    let quoteText = ctx.quoted.text || '';
    if (quoteText.length > 150) quoteText = quoteText.substring(0, 150) + '...';
    
    const mediaNote = ctx.quoted.hasMedia ? '<Media attached>' : '';
    const combinedQuoteText = quoteText ? `"${quoteText}"` : mediaNote;
    userContent = `<quoted_message trust="untrusted">${JSON.stringify({
      from: quoteSender,
      text: combinedQuoteText,
    })}</quoted_message>\n${userContent}`;
  }

  // /chat with no additional text in a group: prompt the user for input.
  if (!userContent && !ctx.hasMedia) {
    if (isGroup && text.toLowerCase().startsWith('/chat')) {
      await deliverDurableText(ctx, t(ctx.language, 'agent.chat_prompt') || 'What would you like to talk about?', 'chat:prompt');
      return;
    }
    return;
  }

  const chatType = isGroup ? 'Group' : 'Private';
  log.info({ chatType, chatId, platform, hasMedia: ctx.hasMedia, textLength: userContent.length }, 'Incoming message received');

  try {
    // Room is already fetched above; derive the language label for the system prompt.
    const langFull = room.language === 'id' ? 'Indonesian (Bahasa Indonesia)' : 'English';

    // 1. Save User Message (idempotent - Baileys can emit the same message event twice on reconnect/history sync)
    const transcript = await transcribeVoiceIfAny(ctx);
    if (transcript) {
      userContent = `${userContent}\n\n[Voice Transcript]\n${transcript}`;
    }

    const inboundInsert = await db.insert(messages).values({
      chatRoomId: chatId,
      senderId: ctx.senderId,
      senderName,
      role: 'user',
      content: userContent,
      platform,
      providerMessageId: ctx.messageId,
      rawMessage: sanitizeRawMessage(ctx.rawMessage),
      mediaPath: ctx.mediaPath,
      mimeType: ctx.mimeType,
      created_at: new Date(),
    }).onConflictDoNothing().run() as unknown as { changes: number };

    if (Number(inboundInsert.changes) === 0) {
      log.info({ chatId, messageId: ctx.messageId }, 'Duplicate provider event ignored');
      return;
    }

    // 1.5 Handle Async Media Downloading 
    // WhatsApp/Discord begin their downloads in the background when the message arrives.
    if (ctx.hasMedia || ctx.quoted?.hasMedia) {
      const syncDbMedia = async () => {
        try {
          if (ctx.mediaPath) {
            await db.update(messages)
              .set({ mediaPath: ctx.mediaPath, mimeType: ctx.mimeType })
              .where(and(
                eq(messages.platform, platform),
                eq(messages.chatRoomId, chatId),
                eq(messages.providerMessageId, ctx.messageId),
              ));
          }
          if (ctx.quoted?.mediaPath && ctx.quoted.stanzaId) {
            // Also update the quoted message in DB if it was downloaded here
            await db.update(messages)
              .set({ mediaPath: ctx.quoted.mediaPath, mimeType: ctx.quoted.mimeType })
              .where(and(
                eq(messages.platform, platform),
                eq(messages.chatRoomId, chatId),
                eq(messages.providerMessageId, ctx.quoted.stanzaId),
              ));
          }
        } catch (err) {
          log.error({ err }, 'Failed to sync DB with downloaded media paths');
        }
      };

      if (shouldTriggerAI) {
        // Block execution so AI can see the media in context
        await ctx.react?.('📥');
        await ctx.mediaReady;
        await syncDbMedia();
      } else {
        // Non-blocking background sync for passive ingestion
        ctx.mediaReady.then(syncDbMedia).catch(() => {});
      }
    }

    // 3. Check if we should actually generate a response (Optimized: moved up to skip expensive history fetch)
    if (!shouldTriggerAI) {
       // Since it's casual chatter, we saved it to context, but we don't reply!
       return;
    }

    // Immediately signal that we are processing (prevents perceived delays if summarization runs)
    await ctx.react?.('⏳').catch(() => {});
    await ctx.sendTyping?.().catch(() => {});

    // 2. Retrieve Context (Now guaranteed to have mediaPath if we awaited it above)
    // V7.11: Use the higher of room config vs role privilege context limit.
    // `-1` means unlimited (ROLE_PRIV_* convention) and always wins.
    const turnBudgetConfig = getTurnBudgetConfig();
    const requestedContextLimit =
      config.contextLimit === UNLIMITED || privileges.contextLimit === UNLIMITED
        ? UNLIMITED
        : Math.max(config.contextLimit, privileges.contextLimit);
    const effectiveContextLimit = requestedContextLimit === UNLIMITED
      ? turnBudgetConfig.operationalContextLimit
      : Math.max(1, Math.min(requestedContextLimit, turnBudgetConfig.operationalContextLimit));

    // Optimization: Select only necessary columns to avoid fetching large 'rawMessage' blobs
    const historyFetchLimit = config.summarize
      ? Math.min(effectiveContextLimit * 3, turnBudgetConfig.operationalContextLimit * 2)
      : effectiveContextLimit;
    const historyDesc = await db.select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      mediaPath: messages.mediaPath,
      mimeType: messages.mimeType,
      created_at: messages.created_at,
      providerMessageId: messages.providerMessageId,
    })
      .from(messages)
      .where(eq(messages.chatRoomId, chatId))
      .orderBy(desc(messages.created_at), desc(messages.id))
      .limit(historyFetchLimit);

    // ⚡ Bolt: Reverse the descending array in O(N) instead of sorting in O(N log N)
    const history = historyDesc.reverse();

    const roleLabel = userRoles.filter(role => role !== 'user').join(', ') || 'user';
    const userContextLine = `\nCurrent user roles: ${roleLabel}.`;

    let memoryContext = '';
    if (config.longTermMemory) {
      const ownerId = ctx.senderId;
      const ranked = await rankMemoriesForInjection(ownerId, userContent);
      const mems = ranked
        ? ranked.map(memory => ({ id: memory.id, content: memory.content }))
        : (await db.select({ id: memories.id, content: memories.content }).from(memories).where(eq(memories.ownerId, ownerId))
          .orderBy(desc(memories.created_at))
          .limit(MAX_INJECTED_MEMORIES)).reverse();
      if (mems.length > 0) {
        const bounded = mems
          .filter(memory => memory.content.length <= 2_000)
          .slice(0, MAX_INJECTED_MEMORIES)
          .map(memory => ({ id: memory.id, content: memory.content }));
        memoryContext = `\n\n<untrusted_long_term_memory>${JSON.stringify(bounded)}</untrusted_long_term_memory>`;
      }
    }

    const systemPromptText = config.systemPrompt.replace('{{LANGUAGE}}', langFull) + userContextLine;
    
    const messagesForAI: AIChatMessage[] = [
      { role: 'system', content: systemPromptText },
      ...(memoryContext ? [{ role: 'user' as const, content: memoryContext }] : []),
    ];

    /**
     * V7.13: Build content parts for a message with media.
     *
     * @param mediaPath   Absolute path to the local media file.
     * @param mimeType    MIME type of the file.
     * @param textContext The text content to accompany the media.
     * @param embedInline When true, read the file and embed it as a base64 data URI content
     *                    block (image_url / video_url / audio_url). When false, only emit a
     *                    plain-text note describing the attachment — used for history messages
     *                    so we don't flood providers with every image ever sent.
     */
    const buildMediaParts = async (
      mediaPath: string,
      mimeType: string,
      textContext: string,
      embedInline: boolean,
    ): Promise<AIChatMessage['content']> => {
      if (!mediaPath || !existsSync(mediaPath)) return textContext;

      if (!embedInline) {
        // History context: just tell the AI what kind of media was there
        const mediaLabel = mimeType.startsWith('image/')
          ? '[Image attached]'
          : mimeType.startsWith('video/')
          ? '[Video attached]'
          : mimeType.startsWith('audio/')
          ? '[Audio attached]'
          : `[Attachment: ${mimeType}]`;
        return `${textContext}\n${mediaLabel}`;
      }

      // Inline embed for the current turn (current message or quoted attachment).
      // Only images are embedded — see the video/audio note below.
      if (!mimeType.startsWith('image/')) {
        if (!mimeType.startsWith('video/') && !mimeType.startsWith('audio/')) {
          // Docs/PDFs: text note so the AI can invoke a tool (e.g., pdf reader)
          return [{ type: 'text', text: `${textContext}\n[Attachment included: ${mimeType}]` }];
        }
        const kind = mimeType.startsWith('video/') ? 'Video' : 'Audio';
        return [{
          type: 'text',
          text: `${textContext}\n[${kind} attached: ${mimeType} — use media tools (e.g. 'sticker', 'convert_media', 'transcribe_audio') to process it]`,
        }];
      }

      try {
        const eligibility = await getInlineMediaEligibility(mediaPath, mimeType);
        if (!eligibility.eligible) {
          return `${textContext}\n[Image omitted from model context: ${eligibility.reason}]`;
        }
        const fileBuffer = await readFile(mediaPath);
        const base64Data = fileBuffer.toString('base64');
        const dataUri = `data:${mimeType};base64,${base64Data}`;

        return [
          { type: 'text', text: textContext },
          { type: 'image_url', image_url: { url: dataUri } },
        ];
      } catch (err) {
        log.error({ err, path: mediaPath }, 'Failed to read media for AI context');
        return textContext;
      }
    };

    // ⚡ Bolt: Use Promise.all to prevent sequential I/O bottlenecks when processing history with media
    const historyMessages = await Promise.all(history.map(async (m) => {
      const isCurrentMessage = m.providerMessageId && m.providerMessageId === ctx.messageId;
      const textPrefix = m.role === 'user' ? '[Participant]: ' : '';
      const textContent = textPrefix + m.content;

      // V7.13: Only embed media inline for the current incoming message.
      // History rows use text notes to avoid flooding providers with every past image.
      const embedInlet = !!isCurrentMessage;
      let finalContent = await buildMediaParts(m.mediaPath || '', m.mimeType || '', textContent, embedInlet);

      // Inject quoted media inline into the context of the CURRENT message only
      if (isCurrentMessage && ctx.quoted?.hasMedia) {
        finalContent = `${typeof finalContent === 'string' ? finalContent : textContent}\n[Quoted attachment omitted from inline model context]`;
      }

      return {
        role: m.role as 'user' | 'assistant',
        content: finalContent,
      };
    }));

    if (config.summarize) {
      const entries = historyMessages.map((message, index) => ({
        id: String(history[index]?.id ?? index),
        message,
      }));
      const summaryRun = await persistentSummaryService.summarize({
        scope: `${platform}:${chatId}`,
        entries,
        keepCount: effectiveContextLimit,
        callLLM: async summaryMessages => {
          const response = await modelRouter.chatCompletion(summaryMessages, undefined, 0.2, undefined, 'fast');
          return typeof response.content === 'string' ? response.content : '';
        },
      });
      const summaryContext: AIChatMessage[] = summaryRun.summary
        ? [{
            role: 'user',
            content: `<conversation_summary trust="untrusted">${JSON.stringify(summaryRun.summary)}</conversation_summary>`,
          }]
        : [];
      messagesForAI.splice(
        1,
        messagesForAI.length - 1,
        ...summaryContext,
        ...(memoryContext ? [{ role: 'user' as const, content: memoryContext }] : []),
        ...summaryRun.activeHistory,
      );
    } else {
      messagesForAI.push(...historyMessages.slice(-effectiveContextLimit));
    }

    // 4. Generate AI Response (Recursive for tools)
    healthMetrics.recordMessageReceived();
    
    let isDone = false;
    let finalAiResponseText = '';
    let streamedResponseSent = false;
    const internalErrorText = t(ctx.language, 'agent.internal_error');
    const allowedTools = config.allowTools ? getAllowedTools(userRoles, ctx.isGroup, platform) : [];
    const allowedToolNames = new Set(allowedTools.map((tool) => tool.name));

    // ── V7.14: Smart Tool Loading ──────────────────────────────────────────
    // Instead of sending ALL tool definitions to the LLM, we send only:
    //   1. Always-loaded tools (web_search, menu, find_tools) — ~600 tokens
    //   2. Trigger-matched tools (URL → download, image → sticker, etc.)
    // The model can discover additional tools via `find_tools` at runtime.
    // Fallback: toolLoadingMode='all' sends everything (legacy behaviour).
    const toolLoadingMode = getToolLoadingMode();

    let availableTools: ToolDefinition[] | undefined;
    // Track dynamically discovered tool names for authorization
    const dynamicToolNames = new Set<string>();

    if (allowedTools.length === 0) {
      availableTools = undefined;
    } else if (toolLoadingMode === 'all') {
      // Legacy: send all permitted tool definitions
      availableTools = getToolDefinitions({ roles: userRoles, isGroup, isOwner: userRoles.includes('owner'), platform });
    } else {
      // ⚡ Bolt: Eliminate multiple intermediate arrays and O(N) filter/map chains by processing
      // tool definitions in a single pass. This significantly reduces garbage collection pressure
      // during the hot-path message handling loop.
      availableTools = [];
      const alwaysLoadedNames: string[] = [];
      const triggeredNames: string[] = [];
      const seenNames = new Set<string>();

      // 1. Process always-loaded tools
      for (const d of getAlwaysLoadedDefinitions({ roles: userRoles, isGroup, isOwner: userRoles.includes('owner'), platform })) {
        const toolName = d.function.name;
        if (allowedToolNames.has(toolName)) {
          availableTools.push(d);
          alwaysLoadedNames.push(toolName);
          seenNames.add(toolName);
        }
      }

      // 2. Process trigger-matched tools
      const mimeHint = ctx.mimeType || ctx.quoted?.mimeType || '';
      for (const t of getTriggeredTools(userContent, mimeHint, { roles: userRoles, isGroup, isOwner: userRoles.includes('owner'), platform })) {
        const toolName = t.name;
        if (allowedToolNames.has(toolName) && !seenNames.has(toolName)) {
          availableTools.push(t.definition);
          triggeredNames.push(toolName);
          seenNames.add(toolName);
        }
      }

      log.info({
        chatId,
        alwaysLoaded: alwaysLoadedNames,
        triggered: triggeredNames,
        totalPermitted: allowedTools.length,
        mode: 'search',
      }, '[Agent] Smart tool loading');
    }

    const streamingConfig = getStreamingConfig();
    const maxToolIterations = getMaxToolIterations();
    const toolTurnBudget = createTurnBudget({
      maxToolCalls: turnBudgetConfig.maxToolCalls,
      maxParallelToolCalls: turnBudgetConfig.maxParallelTools,
      maxToolResultBytes: turnBudgetConfig.maxToolResultBytes,
      maxTotalToolResultBytes: turnBudgetConfig.maxToolResultBytesTotal,
    });
    const editInterval = platform === 'whatsapp' ? streamingConfig.waEditIntervalMs : streamingConfig.dcEditIntervalMs;
    let preferredTier: ModelTier | undefined;

    for (let iteration = 0; iteration < maxToolIterations && !isDone; iteration++) {
      try {
        // Show typing indicator before each LLM call
        await ctx.sendTyping?.();

        // ── Streaming path ──────────────────────────────────────────────────
        // We only use streaming for the *final* response (no tool definitions)
        // or when the model has exhausted tool iterations and we expect text.
        const useStreaming =
          streamingConfig.enabled &&
          typeof ctx.sendMessage === 'function' &&
          typeof ctx.editMessage === 'function';

        if (useStreaming) {
          // Accumulate chunks and do rate-limited edits of the live message
          let accumulated = '';
          let sentKey: unknown = null;
          let lastEditTime = 0;
          let streamingFailed = false;
          const toolCallAccumulator = new StreamingToolCallAccumulator();

          const streamTools = availableTools;
          for await (const chunk of modelRouter.chatCompletionStream(
            messagesForAI,
            streamTools,
            config.temperature,
            config.maxTokens,
            preferredTier,
          )) {
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.tool_calls) {
              toolCallAccumulator.consumeDelta(delta.tool_calls);
              continue;
            }

            // Accumulate text content
            if (delta.content) {
              accumulated += delta.content;

              const now = Date.now();
              if (now - lastEditTime >= editInterval) {
                const displayText = accumulated + ' ▌';
                if (!streamingFailed) {
                  if (!sentKey) {
                    try {
                        sentKey = await ctx.sendMessage!(displayText, ctx.signal ? { signal: ctx.signal } : undefined);
                      streamedResponseSent = true;
                    } catch (err: unknown) {
                      log.warn({ err: getErrorMessage(err), chatId, mode: 'stream' }, '[Agent] Streaming send failed, falling back');
                      streamingFailed = true;
                    }
                  } else {
                    try {
                      await ctx.editMessage!(sentKey, displayText);
                    } catch (err: unknown) {
                      log.warn({ err: getErrorMessage(err), chatId, mode: 'stream' }, '[Agent] Streaming edit failed, degrading gracefully');
                      streamingFailed = true;
                    }
                  }
                }
                lastEditTime = now;
              }
            }
          }

          // If the stream produced tool calls, we need to process them
          const streamedToolCalls = toolCallAccumulator.finish();
          if (streamedToolCalls.length > 0) {
            if (sentKey && !streamingFailed) {
              await ctx.editMessage!(sentKey, accumulated.trim() || '🔧 Running tools...').catch(() => {});
              // Keep streamedResponseSent === true: sentKey remains the live message
              // and is edited with the final text below, so the final ctx.reply is skipped.
            } else if (streamingFailed) {
              streamedResponseSent = false;
            }

            // ⚡ Bolt: Combine Array.from() and map() to avoid allocating an intermediate array, reducing GC pressure
            const toolCalls: ToolCall[] = streamedToolCalls.map(call => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.function.name, arguments: call.function.arguments },
            }));

            messagesForAI.push({
              role: 'assistant' as const,
              content: accumulated || '',
              tool_calls: toolCalls,
            });

            // Execute tools
            const execution = await executeRequestedToolCalls(toolCalls, {
              ctx,
              chatId,
              iteration,
              allowedToolNames,
              dynamicToolNames,
              availableTools,
              toolLoadingMode,
              preferredTier,
              logMalformedArgs: false,
              turnBudget: toolTurnBudget,
              mode: 'stream',
            });
            preferredTier = execution.preferredTier;
            messagesForAI.push(...execution.toolResults);
            continue; // Loop again for the next LLM call
          }

          // Stream produced only text — we are done
          isDone = true;
          finalAiResponseText = accumulated.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() || internalErrorText;

          // Final edit to remove cursor indicator
          if (sentKey && finalAiResponseText !== internalErrorText && !streamingFailed) {
            try {
              await ctx.editMessage!(sentKey, finalAiResponseText);
            } catch (err: unknown) {
              log.warn({ err: getErrorMessage(err), chatId, mode: 'stream_final' }, '[Agent] Final streaming edit failed (observable)');
              streamingFailed = true;
            }
          }
          
          if (streamingFailed) {
            streamedResponseSent = false;
          }
          continue;
        }

        // ── Non-streaming (original) path ───────────────────────────────────
        const aiMsgObj: ChatCompletionMessage = await modelRouter.chatCompletion(
          messagesForAI, availableTools, config.temperature, config.maxTokens, preferredTier,
        );

        if (verboseAiLogs) {
          log.info({
            chatId,
            platform,
            hasToolCalls: Array.isArray(aiMsgObj?.tool_calls) && aiMsgObj.tool_calls.length > 0,
            contentType: Array.isArray(aiMsgObj?.content) ? 'array' : typeof aiMsgObj?.content,
            messageKeys: Object.keys(aiMsgObj || {}),
          }, '[Agent] Raw AI step received');
        }

        // Append the AI's step back to the context
        messagesForAI.push({
          role: 'assistant' as const,
          content: aiMsgObj.content ?? '',
          ...(aiMsgObj.tool_calls ? { tool_calls: aiMsgObj.tool_calls } : {}),
        });

        if (aiMsgObj.tool_calls && aiMsgObj.tool_calls.length > 0) {
          log.info({ chatId, toolCount: aiMsgObj.tool_calls.length, iteration }, 'LLM requested tool calls');
          // Tool Call Requested - Parallel Execution
          const execution = await executeRequestedToolCalls(aiMsgObj.tool_calls, {
            ctx,
            chatId,
            iteration,
            allowedToolNames,
            dynamicToolNames,
            availableTools,
            toolLoadingMode,
            preferredTier,
            logMalformedArgs: true,
            turnBudget: toolTurnBudget,
          });
          preferredTier = execution.preferredTier;
          messagesForAI.push(...execution.toolResults);
        } else {
          // Standard text response (terminal state)
          isDone = true;
          finalAiResponseText = extractAssistantText(aiMsgObj);
          if (!finalAiResponseText) {
            finalAiResponseText = internalErrorText;
            log.warn({
              chatId,
              platform,
              contentType: Array.isArray(aiMsgObj?.content) ? 'array' : typeof aiMsgObj?.content,
              hasRefusal: !!aiMsgObj?.refusal,
              hasOutputText: !!aiMsgObj?.output_text,
              messageKeys: Object.keys(aiMsgObj || {}),
            }, '[Agent] AI returned no usable assistant text; using internal_error fallback');
          }
        }

      } catch (e) {
        log.error({ err: getErrorMessage(e), chatId }, 'Failed to get AI completion or execute tool');
        healthMetrics.recordMessageError();
        finalAiResponseText = t(ctx.language, 'agent.internal_error');
        isDone = true;
      }
    }

    if (!isDone) {
      log.warn({
        chatId,
        platform,
        maxToolIterations,
      }, '[Agent] Aborted inference loop after reaching max tool iterations');
      finalAiResponseText = internalErrorText;
    }

    // 4. Save Final AI Response
    await db.insert(messages).values({
      chatRoomId: chatId,
      senderId: 'bot',
      senderName: 'ElastraX',
      role: 'assistant',
      content: finalAiResponseText,
      platform,
      created_at: new Date(),
    });

    const replyAlreadyDelivered = streamedResponseSent && finalAiResponseText !== internalErrorText;
    if (replyAlreadyDelivered) {
      OutboxService.recordTextDelivered(platform, chatId, finalAiResponseText, [ctx.messageId, 'assistant']);
    } else {
      const deliveryId = OutboxService.enqueueText(
        platform,
        chatId,
        finalAiResponseText,
        [ctx.messageId, 'assistant'],
      );
      try {
        const result = await ctx.reply(finalAiResponseText, ctx.signal ? { signal: ctx.signal } : undefined);
        const providerMessageId = typeof result === 'string' ? result : null;
        OutboxService.markEnqueuedSent(deliveryId, providerMessageId);
      } catch (error) {
        log.warn({ err: error, deliveryId }, 'Immediate delivery failed; outbox will retry');
      }
    }
    await ctx.react?.('✅').catch(() => {});
    healthMetrics.recordMessageProcessed();

    const duration_ms = Date.now() - startMs;
    healthMetrics.recordMessageDuration(duration_ms);

    const usedFallbackError = finalAiResponseText === internalErrorText;
    const logPayload = {
      chatId,
      platform,
      usedFallbackError,
      replyLength: finalAiResponseText.length,
      hasMedia: ctx.hasMedia,
      quotedMedia: !!ctx.quoted?.hasMedia,
      duration_ms,
      roles: userRoles,
      usedTokens: -1, // DEPRECATED - now tracked in health metrics natively
    };
    if (usedFallbackError) {
      log.warn(logPayload, 'Successfully responded');
    } else {
      log.info(logPayload, 'Successfully responded');
    }

  } catch (error) {
    log.error(error, 'Error handling message');
    healthMetrics.recordMessageError();
    await ctx.react?.('❌').catch(() => {}); // show error
    await deliverDurableText(ctx, t(ctx.language, 'agent.internal_error'), 'agent:fatal');
  }
}
