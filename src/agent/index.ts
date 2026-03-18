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
import { chatRooms, messages } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { MessageContext } from '../core/MessageContext';
import { AIChatMessage } from '../ai/client';
import { logger } from '../utils/logger';
import { getToolByName, getToolByAliasOrName, getAlwaysLoadedDefinitions, getTriggeredTools, tools, toolSearchIndex } from '../tools';

const log = logger.child({ module: 'Agent' });
import { ParameterValidator } from '../utils/ParameterValidator';
import { FlowHandler } from '../core/FlowHandler';
import { t } from '../utils/i18n';
import { levenshtein } from '../utils/similarity';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { ConfigService } from '../utils/ConfigService';
import { getModelRouter } from '../utils/ModelRouter';
import { RateLimiter } from '../utils/RateLimiter';
import { RoleService } from '../utils/RoleService';
import { summarizeHistory } from '../utils/ConversationSummarizer';
import type { ChatCompletionMessage, ToolCall, ModelTier } from '../types/ai';
import type { BaseTool, ToolResult, ToolDefinition } from '../tools/BaseTool';
import { healthMetrics } from '../utils/HealthMetrics';
import { getMaxToolIterations, getStreamingConfig, getToolLoadingMode, getToolTimeoutMs as getConfiguredToolTimeoutMs } from '../config/runtime';
import { isAudioMimeType, isTranscriptionConfigured, resolveTranscriptionSource, transcribeSource } from '../utils/transcription';

const modelRouter = getModelRouter();

function getToolTimeoutMs(): number {
  return getConfiguredToolTimeoutMs();
}

function getAllowedTools(roles: string[], isGroup: boolean): BaseTool[] {
  return tools.filter((tool) => {
    if (tool.groupOnly && !isGroup) return false;
    return RoleService.hasPermission(roles, tool.permissions);
  });
}

function resolveToolResultText(result: ToolResult): string {
  return typeof result === 'object' && result !== null && 'text' in result
    ? result.text
    : result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolArgs(rawArgs: string, toolName: string, logMalformed: boolean): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArgs);
    return isRecord(parsed) ? parsed : {};
  } catch {
    if (logMalformed) {
      log.warn({ raw: rawArgs, toolName }, 'Failed to parse tool arguments');
    }
    return {};
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
    mode?: 'stream';
  },
): Promise<{ toolResults: Array<{ role: 'tool'; tool_call_id: string; name: string; content: string }>; preferredTier?: ModelTier }> {
  let preferredTier = options.preferredTier;

  const toolResults = await Promise.all(toolCalls.map(async (tc: ToolCall) => {
    const toolName = tc.function.name;
    const args = parseToolArgs(tc.function.arguments, toolName, options.logMalformedArgs);
    const tool = getToolByName(toolName);
    let toolResultStr = '';

    if (tool && (options.allowedToolNames.has(tool.name) || options.dynamicToolNames.has(tool.name))) {
      log.info({ toolName, args, chatId: options.chatId, iteration: options.iteration, ...(options.mode ? { mode: options.mode } : {}) }, 'Tool call invoked');
      healthMetrics.recordToolInvocation(toolName);
      await options.ctx.react?.('🔧');
      const rawResult = await executeToolWithTimeout(tool, args, options.ctx);
      toolResultStr = resolveToolResultText(rawResult);
      preferredTier = tool.modelTier;

      if (toolName === 'find_tools' && options.toolLoadingMode === 'search') {
        const query = typeof args.query === 'string' ? args.query : '';
        const discovered = discoverMatchingTools(
          query,
          options.allowedToolNames,
          options.dynamicToolNames,
          options.availableTools,
        );
        log.info({ chatId: options.chatId, discovered }, '[Agent] Tools discovered via find_tools');
      }
    } else if (tool) {
      log.warn({ toolName, chatId: options.chatId, senderId: options.ctx.senderId }, 'LLM requested unauthorized tool');
      toolResultStr = `Error: You do not have permission to use tool ${toolName}.`;
    } else {
      log.error({ toolName, chatId: options.chatId }, 'LLM requested unknown tool');
      toolResultStr = `Error: Tool ${toolName} not found.`;
    }

    return {
      role: 'tool' as const,
      tool_call_id: tc.id,
      name: toolName,
      content: toolResultStr,
    };
  }));

  return { toolResults, preferredTier };
}

/**
 * Strip Qwen3-style `<think>…</think>` reasoning blocks from model output,
 * returning only the user-visible portion of the response.
 */
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
    const text = content
      .map((part: unknown) => {
        if (typeof part === 'string') return part;
        if (
          typeof part === 'object'
          && part !== null
          && 'text' in part
          && typeof (part as { text?: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function executeToolWithTimeout(
  tool: BaseTool,
  args: Record<string, unknown>,
  ctx: MessageContext,
): Promise<ToolResult> {
  const startMs = Date.now();
  const timeoutMs = getToolTimeoutMs();

  try {
    const result = await withTimeout(
      Promise.resolve().then(() => tool.execute(args, ctx)),
      timeoutMs,
      `Tool ${tool.name}`,
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
  if (!isTranscriptionConfigured() || !isAudioMimeType(ctx.mimeType)) return null;

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
  if (!room) {
    log.info({ chatId, platform }, 'New chat room created');
    const newRoom = {
      id: chatId,
      platform,
      language: 'en',
      created_at: new Date(),
    };
    await db.insert(chatRooms).values(newRoom).onConflictDoNothing();
    room = {
      ...newRoom,
      systemPrompt: null,
      contextLimit: null,
      temperature: null,
      maxTokens: null,
      allowTools: null,
      autoReplyAll: null,
      summarize: null,
    };
  }
  ctx.language = room.language;

  // V7.11: Resolve user roles once and compute privilege-based rate limits.
  const { roles: userRoles, privileges } = await RoleService.getAccessProfile(await ctx.resolveRoles());

  logger.info(
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
  const config = ConfigService.getResolvedConfig(room);

  // We will always process the message to save it to context history
  // But we use this flag to decide if the AI should actually generate a reply
  let shouldTriggerAI = !isGroup;

  if (isGroup) {
    // If the room has auto-reply all enabled, the bot treats it like a DM
    if (config.autoReplyAll) {
      shouldTriggerAI = true;
    }

    if (text.toLowerCase().startsWith('/chat') || text.startsWith('/')) {
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

    log.info({ command, query: queryStr, chatId, senderId: ctx.senderId }, 'Slash command received');

    // Map explicit commands dynamically
    const tool = getToolByAliasOrName(command);
    if (tool) {
      // Check permissions
      const hasPermission = await ctx.checkPermissions(tool.permissions);
      if (!hasPermission) {
        log.debug({ command, senderId: ctx.senderId, requiredPermission: tool.permissions }, 'Permission denied for command');
        await ctx.reply(t(ctx.language, 'agent.no_permission'));
        return;
      }

      await ctx.react?.('🔍');
      try {
        const parsedArgs = ParameterValidator.parseArgs(tool, queryStr);
        parsedArgs.__command = command;
        log.debug({ command, toolName: tool.name, args: parsedArgs }, 'Executing slash command');
        const result = await executeToolWithTimeout(tool, parsedArgs, ctx);
        // Support structured ToolResponse with mentions
        if (typeof result === 'object' && result !== null && 'text' in result) {
          await ctx.reply(result.text, { mentions: result.mentions });
        } else {
          await ctx.reply(result);
        }
        await ctx.react?.('✅');
        log.debug({ command, toolName: tool.name }, 'Slash command completed');
      } catch (err: unknown) {
        log.error({ err, command, toolName: tool.name }, 'Slash command execution failed');
        const errMessage = err instanceof Error ? err.message : '';
        await ctx.reply(errMessage || t(ctx.language, 'agent.internal_error'));
        await ctx.react?.('❌');
      }
      return;
    }

    // If an unknown command is issued, warn the user in their language
    log.debug({ command, chatId }, 'Unknown command attempted');

    // Attempt to find a similar command (Did you mean...?)
    let suggestion: string | null = null;
    let bestDistance = Infinity;

    for (const tool of tools) {
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
      await ctx.reply(t(ctx.language, 'agent.did_you_mean', { cmd: command, suggestion }));
    } else {
      await ctx.reply(t(ctx.language, 'agent.unknown_command', { cmd: command }));
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
    
    userContent = `[Replying to ${quoteSender}: ${combinedQuoteText}]\n${userContent}`;
  }

  if (!userContent && !ctx.hasMedia) return;

  const chatType = isGroup ? 'Group' : 'Private';
  log.info({ chatType, senderName, chatId, platform, hasMedia: ctx.hasMedia, textPreview: (userContent || '<media only>').slice(0, 100) }, 'Incoming message received');

  try {
    // Room is already fetched above; derive the language label for the system prompt.
    const langFull = room.language === 'id' ? 'Indonesian (Bahasa Indonesia)' : 'English';

    // 1. Save User Message (idempotent - Baileys can emit the same message event twice on reconnect/history sync)
    const transcript = await transcribeVoiceIfAny(ctx);
    if (transcript) {
      userContent = `${userContent}\n\n[Voice Transcript]\n${transcript}`;
    }

    await db.insert(messages).values({
      chatRoomId: chatId,
      senderId: ctx.senderId,
      senderName,
      role: 'user',
      content: userContent,
      providerMessageId: ctx.messageId,
      rawMessage: JSON.stringify(ctx.rawMessage),
      mediaPath: ctx.mediaPath, // likely undefined at this moment
      mimeType: ctx.mimeType,
      created_at: new Date(),
    }).onConflictDoNothing();

    // 1.5 Handle Async Media Downloading 
    // WhatsApp/Discord begin their downloads in the background when the message arrives.
    if (ctx.hasMedia || ctx.quoted?.hasMedia) {
      const syncDbMedia = async () => {
        try {
          if (ctx.mediaPath) {
            await db.update(messages)
              .set({ mediaPath: ctx.mediaPath, mimeType: ctx.mimeType })
              .where(eq(messages.providerMessageId, ctx.messageId));
          }
          if (ctx.quoted?.mediaPath && ctx.quoted.stanzaId) {
            // Also update the quoted message in DB if it was downloaded here
            await db.update(messages)
              .set({ mediaPath: ctx.quoted.mediaPath, mimeType: ctx.quoted.mimeType })
              .where(eq(messages.providerMessageId, ctx.quoted.stanzaId));
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

    // 2. Retrieve Context (Now guaranteed to have mediaPath if we awaited it above)
    // V7.11: Use the higher of room config vs role privilege context limit.
    const effectiveContextLimit = Math.max(config.contextLimit, privileges.contextLimit);

    // Optimization: Select only necessary columns to avoid fetching large 'rawMessage' blobs
    const historyDesc = await db.select({
      role: messages.role,
      content: messages.content,
      senderName: messages.senderName,
      mediaPath: messages.mediaPath,
      mimeType: messages.mimeType,
      created_at: messages.created_at,
      providerMessageId: messages.providerMessageId,
    })
      .from(messages)
      .where(eq(messages.chatRoomId, chatId))
      .orderBy(desc(messages.created_at))
      .limit(effectiveContextLimit);

    // ⚡ Bolt: Reverse the descending array in O(N) instead of sorting in O(N log N)
    const history = historyDesc.reverse();

    // V7.11: Inject user name + role info into the system prompt so the AI is role-aware.
    const roleLabel = userRoles.filter(r => r !== 'user').join(', ') || 'user';
    const userContextLine = `\nCurrent user: ${senderName} (roles: ${roleLabel}).`;

    // Assemble system prompt with localized injection
    const systemPromptText = config.systemPrompt.replace('{{LANGUAGE}}', langFull) + userContextLine;
    
    // Assemble AI context
    const messagesForAI: AIChatMessage[] = [
      { role: 'system', content: systemPromptText }
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

      // Inline embed for the current turn (current message or quoted attachment)
      try {
        const fileBuffer = await readFile(mediaPath);
        const base64Data = fileBuffer.toString('base64');
        const dataUri = `data:${mimeType};base64,${base64Data}`;

        if (mimeType.startsWith('image/')) {
          return [
            { type: 'text', text: textContext },
            { type: 'image_url', image_url: { url: dataUri } },
          ];
        } else if (mimeType.startsWith('video/')) {
          // video_url is only supported by vLLM/multimodal providers.
          // ModelRouter.sanitizeMessagesForProvider() will strip it for providers that don't support it.
          return [
            { type: 'text', text: textContext },
            { type: 'video_url', video_url: { url: dataUri } },
          ];
        } else if (mimeType.startsWith('audio/')) {
          // audio_url is only supported by vLLM/multimodal providers.
          return [
            { type: 'text', text: textContext },
            { type: 'audio_url', audio_url: { url: dataUri } },
          ];
        } else {
          // Docs/PDFs: text note so the AI can invoke a tool (e.g., pdf reader)
          return [{ type: 'text', text: `${textContext}\n[Attachment included: ${mimeType}]` }];
        }
      } catch (err) {
        log.error({ err, path: mediaPath }, 'Failed to read media for AI context');
        return textContext;
      }
    };

    // ⚡ Bolt: Use Promise.all to prevent sequential I/O bottlenecks when processing history with media
    const historyMessages = await Promise.all(history.map(async (m) => {
      const isCurrentMessage = m.providerMessageId && m.providerMessageId === ctx.messageId;
      const textPrefix = m.role === 'user' ? `[${m.senderName}]: ` : '';
      const textContent = textPrefix + m.content;

      // V7.13: Only embed media inline for the current incoming message.
      // History rows use text notes to avoid flooding providers with every past image.
      const embedInlet = !!isCurrentMessage;
      let finalContent = await buildMediaParts(m.mediaPath || '', m.mimeType || '', textContent, embedInlet);

      // Inject quoted media inline into the context of the CURRENT message only
      if (isCurrentMessage && ctx.quoted?.mediaPath) {
        const quotedParts = await buildMediaParts(
          ctx.quoted.mediaPath,
          ctx.quoted.mimeType || '',
          '[Quoted attachment context]',
          true, // Always embed inline for the active quoted attachment
        );

        const currentArr = Array.isArray(finalContent) ? finalContent : [{ type: 'text', text: finalContent as string }];
        const quotedArr = Array.isArray(quotedParts) ? quotedParts : [{ type: 'text', text: quotedParts as string }];

        finalContent = [...quotedArr, ...currentArr] as AIChatMessage['content'];
      }

      return {
        role: m.role as 'user' | 'assistant',
        content: finalContent,
      };
    }));

    messagesForAI.push(...historyMessages);

    // V7.13: Summarize overflow history only when summarization is enabled for this room.
    // When disabled, the DB query already enforced the limit so no further trimming is needed.
    if (config.summarize) {
      const nonSystemHistory = messagesForAI.slice(1);
      const summaryResult = await summarizeHistory(
        nonSystemHistory,
        config.contextLimit,
        async (summaryMessages) => {
          const msg = await modelRouter.chatCompletion(summaryMessages, undefined, 0.2);
          return String(msg?.content || '');
        }
      );

      if (summaryResult && summaryResult.summary) {
        messagesForAI.splice(1, messagesForAI.length - 1,
          {
            role: 'system',
            content: `Conversation memory summary:\n${summaryResult.summary}`,
          },
          ...summaryResult.activeHistory,
        );
      }
    }

    // ── Conversation Branching ─────────────────────────────────────────────────
    // When the user replies to a message that is outside the current context
    // window, load that message (and its neighbours) from the DB so the AI has
    // the full conversational thread available.
    if (ctx.quoted?.stanzaId) {
      const quotedInWindow = history.some(
        (m) => m.providerMessageId === ctx.quoted!.stanzaId,
      );
      if (!quotedInWindow) {
        try {
          const quotedRow = (
            await db
              .select({
                role: messages.role,
                content: messages.content,
                senderName: messages.senderName,
                created_at: messages.created_at,
              })
              .from(messages)
              .where(
                and(
                  eq(messages.chatRoomId, chatId),
                  eq(messages.providerMessageId, ctx.quoted.stanzaId),
                ),
              )
              .limit(1)
          )[0];

          if (quotedRow) {
            // Inject a synthetic context block right before the active history
            // so the AI sees what the user is referring to.
            const insertIdx = messagesForAI.findIndex((m) => m.role !== 'system');
            const branchMsg: AIChatMessage = {
              role: quotedRow.role as 'user' | 'assistant',
              content: `[Referenced earlier message from ${quotedRow.senderName}]: ${quotedRow.content}`,
            };
            if (insertIdx >= 0) {
              messagesForAI.splice(insertIdx, 0, branchMsg);
            } else {
              messagesForAI.push(branchMsg);
            }
            log.info(
              { chatId, quotedId: ctx.quoted.stanzaId },
              '[Agent] Injected branched context for out-of-window quoted message',
            );
          }
        } catch (err) {
          log.warn({ err }, '[Agent] Failed to load branched quoted context');
        }
      }
    }

    // 4. Generate AI Response (Recursive for tools)
    healthMetrics.recordMessageReceived();
    await ctx.react?.('⏳');
    
    let isDone = false;
    let finalAiResponseText = '';
    let streamedResponseSent = false;
    const internalErrorText = t(ctx.language, 'agent.internal_error');
    const allowedTools = config.allowTools ? getAllowedTools(userRoles, ctx.isGroup) : [];
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
      availableTools = allowedTools.map((tool) => tool.definition);
    } else {
      // Smart mode: always-loaded + trigger-matched tools only
      const alwaysDefs = getAlwaysLoadedDefinitions().filter((d) =>
        allowedToolNames.has(d.function.name),
      );

      // Detect trigger patterns against message text + MIME type
      const mimeHint = ctx.mimeType || ctx.quoted?.mimeType || '';
      const triggered = getTriggeredTools(userContent, mimeHint).filter((t) =>
        allowedToolNames.has(t.name),
      );
      const triggeredDefs = triggered.map((t) => t.definition);

      // Deduplicate (always-loaded tools shouldn't appear twice)
      const seenNames = new Set(alwaysDefs.map((d) => d.function.name));
      const uniqueTriggered = triggeredDefs.filter(
        (d) => !seenNames.has(d.function.name),
      );

      availableTools = [...alwaysDefs, ...uniqueTriggered];

      log.info({
        chatId,
        alwaysLoaded: alwaysDefs.map((d) => d.function.name),
        triggered: uniqueTriggered.map((d) => d.function.name),
        totalPermitted: allowedTools.length,
        mode: 'search',
      }, '[Agent] Smart tool loading');
    }

    const streamingConfig = getStreamingConfig();
    const maxToolIterations = getMaxToolIterations();
    const editInterval = platform === 'whatsapp' ? streamingConfig.waEditIntervalMs : streamingConfig.dcEditIntervalMs;
    let preferredTier: ModelTier | undefined;

    for (let iteration = 0; iteration < maxToolIterations && !isDone; iteration++) {
      try {
        // Show typing indicator before each LLM call
        await ctx.sendTyping?.();

        // ── Streaming path ──────────────────────────────────────────────────
        // We only use streaming for the *final* response (no tool definitions)
        // or when the model has exhausted tool iterations and we expect text.
        const isLastChance = iteration === maxToolIterations - 1;
        const useStreaming =
          streamingConfig.enabled &&
          (typeof ctx.sendMessage === 'function') &&
          (typeof ctx.editMessage === 'function') &&
          (!availableTools || isLastChance);

        if (useStreaming) {
          // Accumulate chunks and do rate-limited edits of the live message
          let accumulated = '';
          let sentKey: unknown = null;
          let lastEditTime = 0;
          const toolCallDeltas: Map<number, { id: string; name: string; args: string }> = new Map();

          const streamTools = isLastChance ? undefined : availableTools;
          for await (const chunk of modelRouter.chatCompletionStream(
            messagesForAI,
            streamTools,
            config.temperature,
            config.maxTokens,
            preferredTier,
          )) {
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // Accumulate tool call deltas if the model decides to invoke tools
            if (delta.tool_calls) {
              for (const tcDelta of delta.tool_calls) {
                const existing = toolCallDeltas.get(tcDelta.index);
                if (!existing) {
                  toolCallDeltas.set(tcDelta.index, {
                    id: tcDelta.id || '',
                    name: tcDelta.function?.name || '',
                    args: tcDelta.function?.arguments || '',
                  });
                } else {
                  if (tcDelta.id) existing.id = tcDelta.id;
                  if (tcDelta.function?.name) existing.name += tcDelta.function.name;
                  if (tcDelta.function?.arguments) existing.args += tcDelta.function.arguments;
                }
              }
              continue;
            }

            // Accumulate text content
            if (delta.content) {
              accumulated += delta.content;

              const now = Date.now();
              if (now - lastEditTime >= editInterval) {
                const displayText = accumulated + ' ▌';
                if (!sentKey) {
                  sentKey = await ctx.sendMessage!(displayText);
                  streamedResponseSent = true;
                } else {
                  await ctx.editMessage!(sentKey, displayText).catch(() => {});
                }
                lastEditTime = now;
              }
            }
          }

          // If the stream produced tool calls, we need to process them
          if (toolCallDeltas.size > 0) {
            const toolCalls: ToolCall[] = Array.from(toolCallDeltas.values()).map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.args },
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
              mode: 'stream',
            });
            preferredTier = execution.preferredTier;
            messagesForAI.push(...execution.toolResults);
            continue; // Loop again for the next LLM call
          }

          // Stream produced only text — we are done
          isDone = true;
          finalAiResponseText = accumulated.trim() || internalErrorText;

          // Final edit to remove cursor indicator
          if (sentKey && finalAiResponseText !== internalErrorText) {
            await ctx.editMessage!(sentKey, finalAiResponseText).catch(() => {});
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
        log.error(e, 'Failed to get AI completion / execute tool');
        healthMetrics.recordMessageError();
        finalAiResponseText = "I'm sorry, I encountered an error during inference.";
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
      // AI messages usually don't have a strict provider ID until sent, 
      // but we can generate a unique local one or leave it null.
      created_at: new Date(),
    });

    // 5. Send Response
    // When streaming was used, the final text was already sent via edits.
    // We only need ctx.reply for the non-streaming path or error fallback.
    const replyAlreadyDelivered = streamedResponseSent && finalAiResponseText !== internalErrorText;
    if (!replyAlreadyDelivered) {
      await ctx.reply(finalAiResponseText);
    }
    await ctx.react?.('✅'); // show success
    healthMetrics.recordMessageProcessed();

    const duration_ms = Date.now() - startMs;
    healthMetrics.recordMessageDuration(duration_ms);

    const usedFallbackError = finalAiResponseText === internalErrorText;
    const logPayload = {
      chatId,
      platform,
      usedFallbackError,
      replyPreview: finalAiResponseText.slice(0, 160),
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
    await ctx.react?.('❌'); // show error
    await ctx.reply(t(ctx.language, 'agent.internal_error'));
  }
}
