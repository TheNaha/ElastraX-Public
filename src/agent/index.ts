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
import { chatRooms, messages, ChatRoom } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { MessageContext } from '../core/MessageContext';
import { AIChatMessage } from '../ai/client';
import { logger } from '../utils/logger';
import { getToolDefinitions, getToolByName, getToolByAliasOrName, tools } from '../tools';

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
import { PrivilegeService } from '../utils/PrivilegeService';
import { summarizeHistory } from '../utils/ConversationSummarizer';
import type { ChatCompletionMessage, ToolCall } from '../types/ai';
import { healthMetrics } from '../utils/HealthMetrics';

const modelRouter = getModelRouter();
const streamingEnabled = process.env.AI_STREAMING === 'true';
/** Minimum interval between message edits during streaming (ms). */
const WA_EDIT_INTERVAL = parseInt(process.env.STREAMING_EDIT_INTERVAL_WA || '1500', 10);
const DC_EDIT_INTERVAL = parseInt(process.env.STREAMING_EDIT_INTERVAL_DC || '500', 10);

/**
 * Strip Qwen3-style `<think>…</think>` reasoning blocks from model output,
 * returning only the user-visible portion of the response.
 */
function stripThinkTags(text: string): string {
  // Remove one or more <think>…</think> blocks (greedy, dotall via [\s\S])
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function extractAssistantText(aiMsgObj: ChatCompletionMessage): string {
  // Use `any` for content because some providers may return non-spec formats
  // (e.g., array-of-parts) even though the typed interface expects string|null.
  const content: any = aiMsgObj?.content;

  if (typeof content === 'string') {
    return stripThinkTags(content);
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
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

async function transcribeVoiceIfAny(ctx: MessageContext): Promise<string | null> {
  const endpoint = process.env.TRANSCRIBE_ENDPOINT;
  if (!endpoint) return null;

  const isAudio = ctx.mimeType?.startsWith('audio/');
  if (!isAudio) return null;

  try {
    await ctx.mediaReady;
    if (!ctx.mediaPath || !existsSync(ctx.mediaPath)) return null;

    const buffer = await readFile(ctx.mediaPath);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': process.env.TRANSCRIBE_API_KEY ? `Bearer ${process.env.TRANSCRIBE_API_KEY}` : '',
      },
      body: JSON.stringify({
        audio_base64: buffer.toString('base64'),
        mime_type: ctx.mimeType || 'audio/ogg',
        language: ctx.language || 'en',
      }),
      signal: AbortSignal.timeout(parseInt(process.env.TRANSCRIBE_TIMEOUT_MS || '45000', 10)),
    });

    if (!response.ok) {
      throw new Error(`Transcription HTTP ${response.status}`);
    }

    const data: any = await response.json();
    const text = (data.text || data.transcript || '').trim();
    return text || null;
  } catch (err: any) {
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
  const { chatId, platform, senderName, text, isGroup, mentionedIds } = ctx;
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
    };
  }
  ctx.language = room.language;

  // V7.11: Resolve user roles once and compute privilege-based rate limits.
  const userRoles = await ctx.resolveRoles();
  const privileges = await PrivilegeService.getEffective(userRoles);

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
        const result = await tool.execute(parsedArgs, ctx);
        // Support structured ToolResponse with mentions
        if (typeof result === 'object' && result !== null && 'text' in result) {
          await ctx.reply(result.text, { mentions: result.mentions });
        } else {
          await ctx.reply(result);
        }
        await ctx.react?.('✅');
        log.debug({ command, toolName: tool.name }, 'Slash command completed');
      } catch (err: any) {
        log.error({ err, command, toolName: tool.name }, 'Slash command execution failed');
        await ctx.reply(err?.message || t(ctx.language, 'agent.internal_error'));
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

    const insertResult = await db.insert(messages).values({
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

    const history = historyDesc.slice().sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    // V7.11: Inject user name + role info into the system prompt so the AI is role-aware.
    const roleLabel = userRoles.filter(r => r !== 'user').join(', ') || 'user';
    const userContextLine = `\nCurrent user: ${senderName} (roles: ${roleLabel}).`;

    // Assemble system prompt with localized injection
    const systemPromptText = config.systemPrompt.replace('{{LANGUAGE}}', langFull) + userContextLine;
    
    // Assemble AI context
    const messagesForAI: AIChatMessage[] = [
      { role: 'system', content: systemPromptText }
    ];

    // Helper to generate AI message parts from local media
    const buildMediaParts = async (mediaPath: string, mimeType: string, textContext: string): Promise<AIChatMessage['content']> => {
      let finalContent: AIChatMessage['content'] = textContext;
      
      if (mediaPath && existsSync(mediaPath)) {
        try {
          const fileBuffer = await readFile(mediaPath);
          const base64Data = fileBuffer.toString('base64');
          const dataUri = `data:${mimeType};base64,${base64Data}`;
          
          if (mimeType.startsWith('image/')) {
            finalContent = [
              { type: 'text', text: textContext },
              { type: 'image_url', image_url: { url: dataUri } }
            ];
          } else if (mimeType.startsWith('video/')) {
            finalContent = [
              { type: 'text', text: textContext },
              { type: 'video_url', video_url: { url: dataUri } }
            ];
          } else if (mimeType.startsWith('audio/')) {
            finalContent = [
              { type: 'text', text: textContext },
              { type: 'audio_url', audio_url: { url: dataUri } }
            ];
          } else {
            // Docs/PDFs: just inform the AI a file is attached so it can use tools (e.g., pdf reader)
            finalContent = [
              { type: 'text', text: `${textContext}\n[Attachment included: ${mimeType}]` }
            ];
          }
        } catch (err) {
          log.error({ err, path: mediaPath }, 'Failed to read media for AI context');
        }
      }
      return finalContent;
    };

    for (const m of history) {
      const isLastMessage = m.providerMessageId && m.providerMessageId === ctx.messageId;
      const textPrefix = m.role === 'user' ? `[${m.senderName}]: ` : '';
      const textContent = textPrefix + m.content;
      
      let finalContent = await buildMediaParts(m.mediaPath || '', m.mimeType || '', textContent);

      // Explicitly inject quoted media into the context of the CURRENT message being sent
      if (isLastMessage && ctx.quoted?.mediaPath) {
        // If the AI already has image parts, we merge the quoted ones. 
        // For simplicity, we just transform this entire message payload into a merged array
        const quotedParts = await buildMediaParts(ctx.quoted.mediaPath, ctx.quoted.mimeType || '', `[Quoted attachment context]`);
        
        // Merge the two arrays (or strings converted to arrays)
        const currentArr = Array.isArray(finalContent) ? finalContent : [{ type: 'text', text: finalContent as string }];
        const quotedArr = Array.isArray(quotedParts) ? quotedParts : [{ type: 'text', text: quotedParts as string }];
        
        finalContent = [...quotedArr, ...currentArr] as AIChatMessage['content'];
      }

      messagesForAI.push({
        role: m.role as 'user' | 'assistant',
        content: finalContent,
      });
    }

    // Summarize overflow history to preserve long-term context while staying token efficient.
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
    const internalErrorText = t(ctx.language, 'agent.internal_error');
    const availableTools = config.allowTools ? getToolDefinitions() : undefined;
    const maxToolIterations = parseInt(process.env.AI_MAX_TOOL_ITERATIONS || '8', 10);
    const editInterval = platform === 'whatsapp' ? WA_EDIT_INTERVAL : DC_EDIT_INTERVAL;

    for (let iteration = 0; iteration < maxToolIterations && !isDone; iteration++) {
      try {
        // Show typing indicator before each LLM call
        await ctx.sendTyping?.();

        // ── Streaming path ──────────────────────────────────────────────────
        // We only use streaming for the *final* response (no tool definitions)
        // or when the model has exhausted tool iterations and we expect text.
        const isLastChance = iteration === maxToolIterations - 1;
        const useStreaming =
          streamingEnabled &&
          (typeof ctx.sendMessage === 'function') &&
          (typeof ctx.editMessage === 'function') &&
          (!availableTools || isLastChance);

        if (useStreaming) {
          // Accumulate chunks and do rate-limited edits of the live message
          let accumulated = '';
          let sentKey: any = null;
          let lastEditTime = 0;
          const toolCallDeltas: Map<number, { id: string; name: string; args: string }> = new Map();

          const streamTools = isLastChance ? undefined : availableTools;
          for await (const chunk of modelRouter.chatCompletionStream(
            messagesForAI,
            streamTools,
            config.temperature,
            config.maxTokens,
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
            const toolPromises = toolCalls.map(async (tc: ToolCall) => {
              const toolName = tc.function.name;
              let args: Record<string, unknown> = {};
              try { args = JSON.parse(tc.function.arguments); } catch { }

              const tool = getToolByName(toolName);
              let toolResultStr = '';
              if (tool) {
                log.info({ toolName, args, chatId, iteration, mode: 'stream' }, 'Tool call invoked');
                healthMetrics.recordToolInvocation(toolName);
                await ctx.react?.('🔍');
                const rawResult = await tool.execute(args, ctx);
                toolResultStr = typeof rawResult === 'object' && rawResult !== null && 'text' in rawResult
                  ? rawResult.text : rawResult;
              } else {
                log.error({ toolName, chatId }, 'LLM requested unknown tool');
                toolResultStr = `Error: Tool ${toolName} not found.`;
              }
              return { role: 'tool' as const, tool_call_id: tc.id, name: toolName, content: toolResultStr };
            });

            const toolResults = await Promise.all(toolPromises);
            messagesForAI.push(...toolResults);
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
          messagesForAI, availableTools, config.temperature, config.maxTokens,
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
          const toolPromises = aiMsgObj.tool_calls.map(async (tc: ToolCall) => {
            const toolName = tc.function.name;
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch (e) {
              log.warn({ raw: tc.function.arguments, toolName }, 'Failed to parse tool arguments');
            }

            const tool = getToolByName(toolName);
            let toolResultStr = '';
            
            if (tool) {
              log.info({ toolName, args, chatId, iteration }, 'Tool call invoked');
              healthMetrics.recordToolInvocation(toolName);
              await ctx.react?.('🔍'); // Feedback to user
              const rawResult = await tool.execute(args, ctx);
              toolResultStr = typeof rawResult === 'object' && rawResult !== null && 'text' in rawResult
                ? rawResult.text : rawResult;
            } else {
              log.error({ toolName, chatId }, 'LLM requested unknown tool');
              toolResultStr = `Error: Tool ${toolName} not found.`;
            }

            return {
              role: 'tool' as const,
              tool_call_id: tc.id,
              name: toolName,
              content: toolResultStr,
            };
          });

          const toolResults = await Promise.all(toolPromises);
          messagesForAI.push(...toolResults);
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
    const streamAlreadySent = streamingEnabled && finalAiResponseText !== internalErrorText
      && typeof ctx.sendMessage === 'function';
    if (!streamAlreadySent) {
      await ctx.reply(finalAiResponseText);
    }
    await ctx.react?.('✅'); // show success
    healthMetrics.recordMessageProcessed();

    const usedFallbackError = finalAiResponseText === internalErrorText;
    const logPayload = {
      chatId,
      platform,
      usedFallbackError,
      replyPreview: finalAiResponseText.slice(0, 160),
      replyLength: finalAiResponseText.length,
      hasMedia: ctx.hasMedia,
      quotedMedia: !!ctx.quoted?.hasMedia,
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
