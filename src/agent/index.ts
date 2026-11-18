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
import { getErrorMessage, safeErrorMessage } from '../utils/errorUtils';
import { jidBareId } from '../utils/jid';
import { isPlainObject } from '../utils/typeGuards';
import {
  getToolByName,
  getAuthorizedTool,
  getAlwaysLoadedDefinitions,
  getToolDefinitions,
  getTriggeredTools,
  getToolsForContext,
  hasBindingGatedTools,
  toolSearchIndex,
  executeAuthorizedCommand,
  runMutatingTool,
  secureDefinition,
  validateAndAuthorizeInvocation,
} from '../tools';
import { ServiceBindingService } from '../utils/ServiceBindingService';

const log = logger.child({ module: 'Agent' });
import { FlowHandler } from '../core/FlowHandler';
import { MAX_INJECTED_MEMORIES, MAX_ROOM_KNOWLEDGE_CHUNKS, UNLIMITED, BOT_NAME } from '../core/constants';
import { t } from '../utils/i18n';
import { levenshtein } from '../utils/similarity';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { ConfigService } from '../utils/ConfigService';
import { getModelRouter, stripToolProtocol } from '../utils/ModelRouter';
import { rankMemoriesForInjection } from '../utils/semanticMemory';
import { RateLimiter } from '../utils/RateLimiter';
import { AuthService } from '../utils/AuthService';
import { createPersistentSummaryService } from '../ai/summaryStore';
import { createTurnBudget, TurnBudgetExceededError, type TurnBudget } from '../ai/turnBudget';
import type { ChatCompletionMessage, ToolCall, ModelTier } from '../types/ai';
import type { BaseTool, ToolArgs, ToolResult, ToolDefinition } from '../tools/BaseTool';
import { healthMetrics } from '../utils/HealthMetrics';
import { getMaxToolIterations, getStreamingConfig, getToolLoadingMode, getToolTimeoutMs as getConfiguredToolTimeoutMs, getTurnBudgetConfig, readBooleanEnv } from '../config/runtime';
import { isAudioMimeType, isTranscriptionConfigured, resolveTranscriptionSource, transcribeSource } from '../utils/transcription';
import { withCancellableTimeout } from '../utils/withTimeout.js';
import { randomUUID } from 'node:crypto';
import { isUsableProviderMessageId } from './messageId';
import { retrieveRoomKnowledge, formatRoomKnowledge } from '../utils/roomKnowledge';
import { sanitizeRawMessage } from '../utils/rawMessage';
import { stripPartialThinkTags, stripThinkTags } from '../utils/textUtils';
import { OutboxService, DIRECT_SEND_GRACE_MS } from '../messaging/OutboxService';
import { ToolProgressTracker, formatToolAction } from './toolProgress';
import { getInlineMediaEligibility } from '../providers/media';
import {
  chatRoomKeyInsertValues,
  chatRoomsRoomColumns,
  messageRoomKeyInsertValues,
  messagesRoomColumns,
  pickPreferredRoomRow,
  resolveRoomIdentity,
  roomIdentityCondition,
} from './roomKey';

const modelRouter = getModelRouter();
const persistentSummaryService = createPersistentSummaryService();

function getToolTimeoutMs(): number {
  return getConfiguredToolTimeoutMs();
}

function getAllowedTools(
  roles: string[],
  isGroup: boolean,
  platform = 'whatsapp',
  hasBinding?: boolean,
): BaseTool[] {
  return getToolsForContext({
    roles,
    isGroup,
    platform,
    isOwner: roles.includes('owner'),
    ...(hasBinding === undefined ? {} : { hasBinding }),
  });
}

/**
 * Whether the sender has a linked media-service account.
 *
 * A failure to read the binding table is treated as "no binding" so a
 * database problem hides the media tools rather than exposing them.
 */
async function resolveSenderHasBinding(senderId: string, platform: string): Promise<boolean> {
  try {
    const [binding, seerr] = await Promise.all([
      ServiceBindingService.getBinding(senderId, platform, 'jellyfin'),
      ServiceBindingService.getBinding(senderId, platform, 'seerr'),
    ]);
    return Boolean(binding || seerr);
  } catch (error) {
    log.debug({ err: error, senderId }, 'Binding lookup failed; treating sender as unbound');
    return false;
  }
}

function resolveToolResultText(result: ToolResult): string {
  return typeof result === 'object' && result !== null && 'text' in result
    ? result.text
    : result;
}

function isChatCommand(text: string): boolean {
  return /^\/chat(?=\s|$)/i.test(text);
}

const SUMMARY_LOOKAHEAD = 16;
/** Smallest summarization batch worth a model call. */
const SUMMARY_MIN_BATCH = 8;

/**
 * Direct-send budget inside {@link DIRECT_SEND_GRACE_MS}.
 *
 * The grace exists so the 1 s poller cannot claim a row while the agent is
 * sending it itself. `OutboxService` compares `available_at` against
 * `Date.now() + CLOCK_SKEW_BUFFER_MS` (5 s), so the row becomes claimable
 * `GRACE - SKEW` seconds after it was written — the timeout has to stay inside
 * *that*, not inside the raw grace, or the last seconds of a slow send overlap
 * the tick that claims the row.
 */
const DIRECT_SEND_TIMEOUT_MS = Math.max(1_000, DIRECT_SEND_GRACE_MS - 10_000);

/**
 * Parts of an outbox idempotency key for one assistant reply.
 *
 * The provider message id identifies the turn, and it is only usable when the
 * provider actually supplied one: WhatsApp falls back to `'unknown'`, and every
 * such message in a room hashed to the same key, so a second reply's row was
 * suppressed by the first (and a failed direct send of the second had nothing
 * left to retry). `InboxService.eventKeyFor` already randomises this case; the
 * outbox now agrees with it.
 */
export function outboxKeyParts(messageId: string | undefined, source: string, chatRoomId: string): string[] {
  // The room is part of the key because provider message ids are only unique
  // *within* a room: a Telegram `message_id` is a per-chat counter, so two chats
  // that both received message 100 hashed to the same outbox row. The conflict
  // clause then repointed one room's row at the other's chat id, delivery
  // refused it, and *both* replies went to dead_letter.
  return isUsableProviderMessageId(messageId)
    ? [messageId, source, chatRoomId]
    : [`local:${randomUUID()}`, source, chatRoomId];
}

/**
 * Longest streaming preview the agent renders inline.
 *
 * Every provider's `editMessage` grows a message by re-editing its head and
 * posting the remainder as *new* messages, so a preview that passes the
 * platform limit re-posts the whole tail on every edit interval — a
 * 6000-character Discord answer arrived as a dozen stacked copies of its tail.
 * The preview is therefore frozen below the smallest platform limit (Discord's
 * 2000 characters). Nothing is lost: the final edit still sends the complete
 * text, head plus one continuation.
 */
const STREAM_PREVIEW_LIMIT = 1_800;

/** Preview text with a trailing ellipsis once it passes {@link STREAM_PREVIEW_LIMIT}. */
function clampStreamPreview(text: string): string {
  // Measured in UTF-16 units, which is what the providers count when they decide
  // whether an edit needs a continuation. Counting code points let an all-emoji
  // answer reach 3600 units before the 1800-point cap applied.
  if (text.length <= STREAM_PREVIEW_LIMIT) return text;
  let end = STREAM_PREVIEW_LIMIT;
  const last = text.charCodeAt(end - 1);
  // Never split a surrogate pair: keep the high surrogate with its partner.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/**
 * Fast path for an outgoing reply: enqueue it durably, send it immediately, and
 * mark the row sent.
 *
 * The row is enqueued with a short grace period and the send is bounded to
 * `DIRECT_SEND_TIMEOUT_MS`, which is strictly inside that grace. Without both
 * halves the 1 s outbox poller could claim the row mid-send and deliver the same
 * text a second time — the window was the whole provider round trip.
 */
async function deliverDurableText(ctx: MessageContext, text: string, source: string, mentions?: string[]): Promise<void> {
  if (!text.trim()) return;
  const deliveryId = OutboxService.enqueueDirectText(
    ctx.platform,
    ctx.chatId,
    text,
    outboxKeyParts(ctx.messageId, source, ctx.chatId),
    { mentions },
  );
  try {
    const replyOptions = {
      ...(mentions?.length ? { mentions } : {}),
    };
    const result = await withCancellableTimeout(
      signal => ctx.reply(text, { ...replyOptions, signal }),
      DIRECT_SEND_TIMEOUT_MS,
      'direct reply',
      ctx.signal,
    );
    const recorded = OutboxService.markEnqueuedSent(deliveryId, typeof result === 'string' ? result : null);
    if (!recorded) {
      // `false` means the row was already `sent` (key collision) or `leased` by
      // the poller, which is delivering the same text concurrently — the exact
      // race the direct-send grace window exists to bound.
      log.warn({ deliveryId, source }, 'Direct send raced the outbox poller; delivery row was already claimed');
    }
  } catch (error) {
    log.warn({ err: error, deliveryId, source }, 'Immediate delivery failed; outbox will retry');
  }
}

function parseToolArgs(rawArgs: string, toolName: string, logMalformed: boolean): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawArgs || '{}');
    if (isPlainObject(parsed)) return parsed;
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
      availableTools.push(secureDefinition(entry.tool));
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
    progressTracker?: ToolProgressTracker;
    /**
     * Role/context used for per-action authorization. The slash path has always
     * applied `COMMAND_POLICIES`; the model path previously validated arguments
     * only, so a table entry such as `role.grant: admin` protected nothing when
     * the model (not the user) chose the action.
     */
    accessContext: { roles: string[]; isGroup: boolean; isOwner: boolean; platform: string; userId: string };
  },
): Promise<{ toolResults: Array<{ role: 'tool'; tool_call_id: string; name: string; content: string }>; preferredTier?: ModelTier }> {
  // The turn budget is claimed *after* validation (below), so a provider that
  // repeats or hallucinates tool names cannot exhaust the per-turn call budget
  // without executing anything.
  type PreparedToolCall =
    | { kind: 'error'; toolCall: ToolCall; toolName: string; errorText: string }
    | { kind: 'ready'; toolCall: ToolCall; toolName: string; tool: BaseTool; validArgs: Record<string, unknown> };

  const prepared: PreparedToolCall[] = [];
  for (const toolCall of toolCalls) {
    const toolName = toolCall.function.name;
    const tool = getToolByName(toolName);
    if (!tool) {
      log.error({ toolName, chatId: options.chatId }, 'LLM requested unknown tool');
      prepared.push({ kind: 'error', toolCall, toolName, errorText: `Error: Tool ${toolName} not found.` });
    } else if (!(options.allowedToolNames.has(tool.name) || options.dynamicToolNames.has(tool.name))) {
      log.warn({ toolName, chatId: options.chatId, senderId: options.ctx.senderId }, 'LLM requested unauthorized tool');
      prepared.push({ kind: 'error', toolCall, toolName, errorText: `Error: You do not have permission to use tool ${toolName}.` });
    } else {
      const args = parseToolArgs(toolCall.function.arguments, toolName, options.logMalformedArgs);
      if (!args) {
        prepared.push({ kind: 'error', toolCall, toolName, errorText: `Error: Arguments for ${toolName} must be a valid JSON object.` });
      } else {
        const validation = validateAndAuthorizeInvocation(tool, args, options.accessContext);
        if (!validation.valid || !isPlainObject(validation.value)) {
          const denied = validation.issues?.some(issue => issue.keyword === 'access') ?? false;
          prepared.push({
            kind: 'error',
            toolCall,
            toolName,
            errorText: denied
              ? `Error: You do not have permission to use ${toolName} for this action.`
              : `Error: Invalid arguments for ${toolName}: ${validation.errors.join('; ')}`,
          });
        } else {
          prepared.push({ kind: 'ready', toolCall, toolName, tool, validArgs: validation.value });
        }
      }
    }
  }

  const readyCount = prepared.filter(p => p.kind === 'ready').length;
  options.progressTracker?.addPlannedSteps(readyCount);

  // Charge only the calls that will actually run. Claiming `toolCalls.length`
  // before validation meant eight unknown/unauthorized/malformed calls in one
  // round exhausted the budget with zero tool executions and every later
  // legitimate call answered "Tool-call limit exceeded". The budget guard is
  // self-imposed, not a system failure, so an exceeded claim is reported back to
  // the model as a tool result rather than thrown out of this function.
  let budgetError: string | null = null;
  if (readyCount > 0) {
    try {
      options.turnBudget.claimToolCalls(readyCount);
    } catch (error) {
      if (!(error instanceof TurnBudgetExceededError)) throw error;
      budgetError = getErrorMessage(error);
      log.warn({ chatId: options.chatId, requested: toolCalls.length, ready: readyCount }, 'Tool-call budget exhausted');
    }
  }

  const toolResults: Array<{ role: 'tool'; tool_call_id: string; name: string; content: string }> = [];
  let preferredTier = options.preferredTier;

  for (const item of prepared) {
    if (item.kind === 'error') {
      toolResults.push({
        role: 'tool',
        tool_call_id: item.toolCall.id,
        name: item.toolName,
        content: item.errorText,
      });
      continue;
    }
    if (budgetError) {
      toolResults.push({
        role: 'tool',
        tool_call_id: item.toolCall.id,
        name: item.toolName,
        content: `Error: ${budgetError}`,
      });
      continue;
    }

    const { toolCall, toolName, tool, validArgs } = item;
    log.info(
      { toolName, chatId: options.chatId, iteration: options.iteration, ...(options.mode ? { mode: options.mode } : {}) },
      'Tool call invoked',
    );
    healthMetrics.recordToolInvocation(toolName);

    const description = typeof tool.describeAction === 'function'
      ? tool.describeAction(validArgs)
      : formatToolAction(tool.name, tool.category ?? 'utility', validArgs);

    const stepIndex = await options.progressTracker?.startStep(description);
    await options.ctx.react?.('🔧').catch(err => log.warn({ err, toolName, chatId: options.chatId }, '[Agent] Reaction failed'));

    let toolResultText: string;
    let resultTier: ModelTier | undefined;
    let toolFailed = false;

    try {
      // Route through runMutatingTool so the LLM path shares the slash
      // command path's mutation rate limit and per-user serialization.
      // Without this, a mutating tool invoked by the model bypassed both.
      const rawResult = await runMutatingTool(
        tool,
        options.ctx,
        () => executeToolWithTimeout(tool, validArgs, options.ctx),
      );
      try {
        const constrained = options.turnBudget.constrainTextResult(resolveToolResultText(rawResult));
        // Keep the fact that the result was cut. The model used to receive a
        // silently truncated JSON/text result and could report a partial list
        // as the complete answer.
        toolResultText = constrained.truncated
          ? `${constrained.value}\n\n[Tool output truncated to fit the per-turn result budget]`
          : constrained.value;
      } catch (budgetError: unknown) {
        if (!(budgetError instanceof TurnBudgetExceededError)) throw budgetError;
        // The tool itself succeeded; only the budget for returning its output is
        // gone. Reporting that as "Error executing tool" told the model the call
        // failed and threw away a successful result.
        log.warn({ toolName, chatId: options.chatId }, 'Tool result dropped: turn budget exhausted');
        toolResultText = `Tool ${toolName} ran, but its output was not returned: ${getErrorMessage(budgetError)}`;
      }
      resultTier = tool.modelTier;
    } catch (err: unknown) {
      toolFailed = true;
      log.error({ err, toolName, chatId: options.chatId }, 'Tool execution failed or timed out');
      // Deliberately NOT routed through turnBudget.constrainTextResult: it
      // throws once the result-byte budget is exhausted, so calling it here
      // would throw out of this catch and discard the entire turn.
      toolResultText = `Error executing tool ${toolName}: ${safeErrorMessage(err, 2000)}`;
    }

    const stepFailed = toolFailed || /^(\s*(?:Error:|❌))/i.test(toolResultText);
    if (stepIndex !== undefined) {
      options.progressTracker?.completeStep(stepIndex, stepFailed);
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

    if (resultTier && !preferredTier) preferredTier = resultTier;
    toolResults.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      name: toolName,
      content: toolResultText,
    });
  }

  await options.progressTracker?.flush();
  return { toolResults, preferredTier };
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
  try {
    await handleMessageInternal(ctx);
  } catch (error) {
    // Everything from the room lookup through role resolution, flow handling and
    // slash routing used to run outside any try, so a failure there escaped
    // before the reply/error path existed: the provider only logged it and the
    // user was silently ignored. The inner handler catches the AI phase itself,
    // so this only fires for the phases before it.
    log.error({ err: error, chatId: ctx.chatId, platform: ctx.platform }, 'Error handling message (pre-reply)');
    healthMetrics.recordMessageError();
    await ctx.react?.('❌').catch(err => log.warn({ err, chatId: ctx.chatId }, '[Agent] Reaction failed'));
    await ctx.reply(t(ctx.language ?? 'en', 'agent.internal_error')).catch(err =>
      log.warn({ err, chatId: ctx.chatId }, '[Agent] Error reply failed'),
    );
    // Rethrow: the caller owns durable delivery state. Swallowing the error made
    // `AppRuntime` mark the inbox row `completed`, so a transient failure (a busy
    // database, a room-config read) was acknowledged and could never be retried.
    throw error;
  }
}

async function handleMessageInternal(ctx: MessageContext): Promise<void> {
  const startMs = Date.now();
  const { chatId, platform, senderName, text, isGroup } = ctx;
  const verboseAiLogs = readBooleanEnv(process.env.AI_VERBOSE_LOGS, false);

  // Fetch or create the chat room early so that ctx.language is available to all
  // tools and flow handlers before any routing takes place.
  //
  // Room identity is the platform-scoped canonical key
  // (`room:<platform>:<chatId>`). Existing rows keep the raw provider id during
  // the migration window; new rows use the canonical key as the internal primary
  // key so identical remote ids on different platforms can coexist. Provider
  // delivery always continues to use `ctx.chatId`.
  const roomIdentity = resolveRoomIdentity(ctx);
  const roomRows = await db
    .select()
    .from(chatRooms)
    .where(roomIdentityCondition(chatRoomsRoomColumns(), roomIdentity));
  let room = pickPreferredRoomRow(roomRows, roomIdentity.roomKey);
  if (room && room.platform !== platform) {
    throw new Error(`Room identity resolves to platform ${room.platform}, expected ${platform}`);
  }
  if (!room) {
    const defaults = ConfigService.getDefaults(isGroup);
    const internalRoomId = roomIdentity.roomKey;
    log.info({ chatId, roomKey: roomIdentity.roomKey, platform }, 'New chat room created');
    const newRoom: typeof chatRooms.$inferInsert = {
      id: internalRoomId,
      ...chatRoomKeyInsertValues(roomIdentity.roomKey),
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
    room = (pickPreferredRoomRow(
      await db.select().from(chatRooms).where(roomIdentityCondition(chatRoomsRoomColumns(), roomIdentity)),
      roomIdentity.roomKey,
    ) ?? {
      ...newRoom,
      id: internalRoomId,
      created_at: newRoom.created_at ?? new Date(),
    }) as typeof chatRooms.$inferSelect;
  }
  if (!room) throw new Error(`Unable to resolve room ${roomIdentity.roomKey}`);
  ctx.language = room.language;
  // Stored id of the resolved room row: used for every foreign-key write below so
  // the row keeps pointing at the same room regardless of the id convention.
  const roomId = room.id;

  // V7.11: Resolve user roles once and compute privilege-based rate limits.
  const { roles: userRoles, privileges } = await AuthService.getAccessProfile(await ctx.resolveRoles());
  /** Authorization context for per-action tool policies (see `COMMAND_POLICIES`). */
  const accessContext = {
    roles: userRoles,
    isGroup: ctx.isGroup,
    isOwner: userRoles.includes('owner'),
    platform,
    userId: ctx.senderId,
  };

  logger.debug(
    { senderId: ctx.senderId, senderPn: ctx.senderPn, chatId: ctx.chatId, userRoles, privileges },
    '[Agent] Role & privilege resolution complete',
  );

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

    if (isChatCommand(text) || text.startsWith('/')) {
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

  // Handle active interactive sessions (bypass normal commands and AI).
  // This runs *before* the rate limiter: a wizard step is a direct answer to the
  // bot, and rejecting it with "rate limited" dropped the answer while leaving
  // the session active, so the user had to know /cancel to get out.
  const inFlow = await FlowHandler.handle(ctx);
  if (inFlow) return;

  // Rate limit only what the bot will actually process. This used to run for
  // every inbound message, so group chatter the bot was never addressed in
  // consumed the sender's budget and then got a "rate limited" reply in the
  // group.
  if ((shouldTriggerAI || text.startsWith('/')) && privileges.maxMessagesPerWindow !== -1) {
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

  // Handle explicit commands (bypass AI conversation loop)
  if (text.startsWith('/') && !isChatCommand(text)) {
    const spaceIdx = text.indexOf(' ');
    const command = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
    const queryStr = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

    log.info({ command, hasArguments: queryStr.length > 0, chatId }, 'Slash command received');

    // Map explicit commands through the shared authorization, grammar, validation,
    // mutation-admission, and execution pipeline.
    const tool = await getAuthorizedTool(command, ctx);
    if (tool) {
      await ctx.react?.('🔧').catch(err => log.warn({ err, command, chatId }, '[Agent] Reaction failed'));
      try {
        const result = await executeAuthorizedCommand(command, queryStr, ctx);
        if (result === undefined) throw new Error('Command access denied');
        log.debug({ command, toolName: tool.name }, 'Executing slash command');
        if (typeof result === 'object' && result !== null && 'text' in result) {
          await deliverDurableText(ctx, result.text, `command:${command}`, result.mentions);
        } else {
          await deliverDurableText(ctx, String(result), `command:${command}`);
        }
        await ctx.react?.('✅').catch(err => log.warn({ err, command, chatId }, '[Agent] Reaction failed'));
        log.debug({ command, toolName: tool.name }, 'Slash command completed');
      } catch (err: unknown) {
        // A malformed command is a *usage* error, not a server fault. The
        // registry and the parameter validator both throw a message that
        // already contains the usage help, and that help was being thrown away
        // in favour of "An internal error occurred" — so every typo looked
        // like a crash.
        const detail = getErrorMessage(err);
        const isUsageError = /^Invalid \S+ arguments:/.test(detail)
          || /Missing argument/i.test(detail)
          || /Command access denied/i.test(detail);
        if (isUsageError) {
          log.info({ err, command, toolName: tool.name }, 'Slash command rejected: invalid usage');
          await deliverDurableText(ctx, detail, `command:${command}:usage`);
        } else {
          log.error({ err, command, toolName: tool.name }, 'Slash command execution failed');
          await deliverDurableText(ctx, t(ctx.language, 'agent.internal_error'), `command:${command}:error`);
        }
        await ctx.react?.('❌').catch(err => log.warn({ err, command, chatId }, '[Agent] Reaction failed'));
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
  // `/chat` is a marker, not a command: strip it wherever the AI is going to run.
  // It was gated on `isGroup`, so a direct message — the one context where the AI
  // always runs — forwarded the literal `/chat` marker to the model. The match is
  // also anchored to a word boundary, so `/chatty` and `/chatops` are ordinary
  // text rather than a `/chat` invocation with `ty` as its payload.
  let userContent = isChatCommand(text)
    ? text.slice('/chat'.length).trim()
    : text;

  // Emphasize quoted context by prepending it directly to the user's message payload
  if (ctx.quoted) {
    const isFromBot = ctx.quoted.rawMessage?.key?.fromMe;
    const quoteSender = isFromBot ? `${BOT_NAME} (You)` : (ctx.quoted.senderId ? jidBareId(ctx.quoted.senderId) : 'unknown');
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
      chatRoomId: roomId,
      ...messageRoomKeyInsertValues(roomIdentity.roomKey),
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
          // A placeholder id (`unknown`/empty) is excluded from the dedupe index
          // because every such row shares it, so an update keyed on it would
          // stamp this message's media path onto every placeholder row in the
          // room.
          if (ctx.mediaPath && isUsableProviderMessageId(ctx.messageId)) {
            await db.update(messages)
              .set({ mediaPath: ctx.mediaPath, mimeType: ctx.mimeType })
              .where(and(
                eq(messages.platform, platform),
                eq(messages.chatRoomId, roomId),
                eq(messages.providerMessageId, ctx.messageId),
              ));
          }
          if (ctx.quoted?.mediaPath && isUsableProviderMessageId(ctx.quoted.stanzaId)) {
            // Also update the quoted message in DB if it was downloaded here
            await db.update(messages)
              .set({ mediaPath: ctx.quoted.mediaPath, mimeType: ctx.quoted.mimeType })
              .where(and(
                eq(messages.platform, platform),
                eq(messages.chatRoomId, roomId),
                eq(messages.providerMessageId, ctx.quoted.stanzaId),
              ));
          }
        } catch (err) {
          log.error({ err }, 'Failed to sync DB with downloaded media paths');
        }
      };

      if (shouldTriggerAI) {
        // Block execution so AI can see the media in context
        await ctx.react?.('📥').catch(err => log.warn({ err, chatId }, '[Agent] Reaction failed'));
        await ctx.mediaReady;
        await syncDbMedia();
      } else {
        // Background sync for passive ingestion; awaited so the DB row is
        // consistent (mediaPath/mimeType set) when handleIncomingMessage returns.
        await ctx.mediaReady.then(syncDbMedia).catch(err => log.warn({ err, chatId }, '[Agent] Background media sync failed'));
      }
    }

    // 3. Check if we should actually generate a response (Optimized: moved up to skip expensive history fetch)
    if (!shouldTriggerAI) {
       // Since it's casual chatter, we saved it to context, but we don't reply!
       return;
    }

    // Immediately signal that we are processing (prevents perceived delays if summarization runs)
    await ctx.react?.('⏳').catch(err => log.warn({ err, chatId }, '[Agent] Reaction failed'));
    await ctx.sendTyping?.().catch(err => log.warn({ err, chatId }, '[Agent] Typing indicator failed'));

    // 2. Retrieve Context (Now guaranteed to have mediaPath if we awaited it above)
    //
    // The room's configured limit and the caller's role privilege compose as
    // **ceiling**, not as a floor. The previous code used `Math.max`, which
    // made the role privilege a *minimum*: the `user` role's built-in limit of
    // 20 meant `/config set contextLimit 5` (and every value from 1 to 19)
    // was accepted, stored, reported back by `/config get` — and then silently
    // ignored. Only values of 20 or more ever had an effect.
    //
    // Now the room setting is the effective limit and the role privilege is
    // the maximum the caller is allowed, so a room can ask for a smaller
    // context window and a role can still widen it up to its own ceiling.
    // `-1` means unlimited (the ROLE_PRIV_* convention).
    const turnBudgetConfig = getTurnBudgetConfig();
    const requestedContextLimit =
      config.contextLimit === UNLIMITED
        ? privileges.contextLimit
        : privileges.contextLimit === UNLIMITED
          ? config.contextLimit
          : Math.min(config.contextLimit, privileges.contextLimit);
    const effectiveContextLimit = requestedContextLimit === UNLIMITED
      ? turnBudgetConfig.operationalContextLimit
      : Math.max(1, Math.min(requestedContextLimit, turnBudgetConfig.operationalContextLimit));

    // Optimization: Select only necessary columns to avoid fetching large 'rawMessage' blobs
    //
    // The summarizing case used to fetch 3x the context limit so the summarizer
    // would have spare material every turn. That made each turn pull 2x
    // effectiveContextLimit rows of history out of SQLite *and* hand the model a
    // batch big enough to summarize on every single message — so the rolling
    // summary was rewritten once per inbound turn, roughly doubling LLM spend and
    // re-sending the whole summary as the prompt prefix each time. A modest
    // lookahead plus a batch threshold (see ConversationSummarizer) summarises
    // every few turns instead, and the fetch is proportional to what is used.
    const historyFetchLimit = config.summarize
      ? Math.min(effectiveContextLimit + SUMMARY_LOOKAHEAD, turnBudgetConfig.operationalContextLimit * 2)
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
      .where(roomIdentityCondition(messagesRoomColumns(), roomIdentity))
      .orderBy(desc(messages.created_at), desc(messages.id))
      .limit(historyFetchLimit);

    // ⚡ Bolt: Reverse the descending array in O(N) instead of sorting in O(N log N)
    const history = historyDesc.reverse();

    const roleLabel = userRoles.filter(role => role !== 'user').join(', ') || 'user';
    const userContextLine = `\nCurrent user roles: ${roleLabel}.`;

    let memoryContext = '';
    let roomKnowledgeContext = '';
    if (config.longTermMemory) {
      if (isGroup) {
        // In a group, inject the room's shared knowledge base rather than the
        // sender's private memory. Personal memory was previously injected here
        // and then folded into the room's rolling summary, which is group-visible
        // state — so one participant's private notes became everyone's context.
        // Shared documents are the room-scoped counterpart and are labelled as
        // reference material, never as instructions.
        if (ctx.roomKey) {
          const hits = await retrieveRoomKnowledge({ roomKey: ctx.roomKey, query: userContent, limit: MAX_ROOM_KNOWLEDGE_CHUNKS });
          const rendered = formatRoomKnowledge(hits);
          if (rendered) roomKnowledgeContext = `\n\n${rendered}`;
        }
      } else {
        const ownerId = ctx.senderId;
        const ranked = await rankMemoriesForInjection(ownerId, userContent);
        const mems = ranked
          ? ranked.map(memory => ({ id: memory.id, content: memory.content }))
          : (await db
              .select({ id: memories.id, content: memories.content })
              .from(memories)
              .where(eq(memories.ownerId, ownerId))
              .orderBy(desc(memories.created_at))
              .limit(MAX_INJECTED_MEMORIES)
            ).reverse();
        if (mems.length > 0) {
          const bounded = mems
            .filter(memory => memory.content.length <= 2_000)
            .slice(0, MAX_INJECTED_MEMORIES)
            .map(memory => ({ id: memory.id, content: memory.content }));
          memoryContext = `\n\n<untrusted_long_term_memory>${JSON.stringify(bounded)}</untrusted_long_term_memory>`;
        }
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
      // Placeholder ids carry no identity, and the dedupe index deliberately
      // excludes them (see messages_provider_message_id_unique). Matching them
      // here would mark every placeholder row as "current" and inline-embed up
      // to INLINE_MEDIA_MAX_BYTES of media for each one.
      const isCurrentMessage =
        isUsableProviderMessageId(m.providerMessageId) &&
        isUsableProviderMessageId(ctx.messageId) &&
        m.providerMessageId === ctx.messageId;
      const textPrefix = m.role === 'user' ? '[Participant]: ' : '';
      const textContent = textPrefix + m.content;

      // V7.13: Only embed media inline for the current incoming message.
      // History rows use text notes to avoid flooding providers with every past image.
      const embedInlet = !!isCurrentMessage;
      let finalContent = await buildMediaParts(m.mediaPath || '', m.mimeType || '', textContent, embedInlet);

      // Inject quoted media inline into the context of the CURRENT message only.
      // When the current message embeds its own image `finalContent` is already an
      // array of content parts; replacing it with the plain text dropped the
      // user's attachment entirely, so the model never saw an image sent as a
      // reply to a media message.
      if (isCurrentMessage && ctx.quoted?.hasMedia) {
        const note = '[Quoted attachment omitted from inline model context]';
        finalContent = Array.isArray(finalContent)
          ? [...finalContent, { type: 'text', text: note }]
          : `${finalContent}\n${note}`;
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
        scope: roomIdentity.roomKey,
        entries,
        keepCount: effectiveContextLimit,
        minBatch: SUMMARY_MIN_BATCH,
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
        ...(roomKnowledgeContext ? [{ role: 'user' as const, content: roomKnowledgeContext }] : []),
        ...summaryRun.activeHistory,
      );
    } else {
      messagesForAI.push(...historyMessages.slice(-effectiveContextLimit));
      if (roomKnowledgeContext) messagesForAI.push({ role: 'user', content: roomKnowledgeContext });
    }

    // 4. Generate AI Response (Recursive for tools)
    healthMetrics.recordMessageReceived();
    
    let isDone = false;
    let finalAiResponseText = '';
    let streamedResponseSent = false;
    const internalErrorText = t(ctx.language, 'agent.internal_error');
    // The media tools declare `requiresBinding`, but the access context never
    // carried a `hasBinding` flag, so the gate could never fire: an unbound
    // user was offered the library and request tools, the model called them,
    // and the tool answered "link your account first" — a wasted round trip
    // and a confusing answer for a feature the user cannot use.
    //
    // The lookup is a single indexed read and only happens when a
    // binding-gated tool is actually registered.
    const hasBinding = config.allowTools && hasBindingGatedTools()
      ? await resolveSenderHasBinding(ctx.senderId, platform)
      : undefined;
    const allowedTools = config.allowTools ? getAllowedTools(userRoles, ctx.isGroup, platform, hasBinding) : [];
    const allowedToolNames = new Set(allowedTools.map((tool) => tool.name));
    // Scheduled runs set this so an unattended agent cannot take destructive or
    // admin actions with nobody watching.
    for (const denied of ctx.deniedToolNames ?? []) allowedToolNames.delete(denied);

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
      // Legacy: send all permitted tool definitions, but still honour the
      // binding gate, scheduled-run denials, and the allowed-tool set so an
      // unbound or unattended run is never offered tools it cannot use.
      availableTools = getToolDefinitions({
        roles: userRoles,
        isGroup,
        isOwner: userRoles.includes('owner'),
        platform,
        hasBinding,
      }).filter((definition) => allowedToolNames.has(definition.function.name));
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
          availableTools.push(secureDefinition(t));
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
    /** Last non-empty assistant text seen, used if the final round produces nothing. */
    let lastAssistantText = '';
    const progressTracker = new ToolProgressTracker(ctx, (err, phase) => {
      log.warn({ err: getErrorMessage(err), chatId, phase }, '[Agent] Tool progress update failed');
    });

    for (let iteration = 0; iteration <= maxToolIterations && !isDone; iteration++) {
      // Every iteration up to the budget may run tools; the extra iteration past
      // it is a text-only round. Without it a turn that legitimately used its
      // whole tool budget ended with `isDone === false` and the accumulated
      // answer was replaced by "An internal error occurred".
      const forceTextOnly = iteration >= maxToolIterations;
      const iterationTools = forceTextOnly ? undefined : availableTools;
      // Some OpenAI-compatible servers reject a history that contains tool
      // results when the request omits the tool definitions, so the forced round
      // sends the history with the tool protocol flattened to plain text.
      const iterationMessages = forceTextOnly ? stripToolProtocol(messagesForAI) : messagesForAI;
      /**
       * Set by the streaming branch to strip the `▌` cursor from a bubble that
       * was already sent, if the stream fails before the branch can finalise it
       * itself. Reset to `null` once the bubble is handed off (tool calls) or
       * finalised, so a later throw in tool execution does not overwrite it.
       */
      let finalizeStreamedBubble: (() => Promise<void>) | null = null;
      try {
        // Show typing indicator before each LLM call
        await ctx.sendTyping?.().catch(err => log.warn({ err, chatId, iteration }, '[Agent] Typing indicator failed'));

        // ── Streaming path ──────────────────────────────────────────────────
        // Stream the LLM response and do rate-limited edits of the live message.
        // Supports both text and tool-call streaming; tool calls are accumulated
        // and then executed after the stream ends.
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
          // A mid-stream provider failure throws out of the `for await` below
          // before any of the branches that finalise the bubble run, leaving the
          // user with a message that still ends in the streaming cursor and a
          // second internal-error reply. This lets the catch strip the cursor.
          finalizeStreamedBubble = async () => {
            if (!sentKey || streamingFailed) return;
            const text = stripThinkTags(accumulated).trim();
            try {
              await ctx.editMessage!(sentKey, text || '…');
            } catch (err: unknown) {
              log.warn({ err: getErrorMessage(err), chatId }, '[Agent] Failed to finalise a failed streamed bubble');
            }
          };

          const streamTools = iterationTools;
          for await (const chunk of modelRouter.chatCompletionStream(
            iterationMessages,
            streamTools,
            config.temperature,
            config.maxTokens,
            preferredTier,
          )) {
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.tool_calls) {
              toolCallAccumulator.consumeDelta(delta.tool_calls);
              // Do not `continue`: a provider may put text and tool calls in the
              // same delta, and skipping the content silently dropped that text.
            }

            // Accumulate text content
            if (delta.content) {
              accumulated += delta.content;

              const now = Date.now();
              if (now - lastEditTime >= editInterval) {
                // Strip the think block, including one still being streamed. The
                // final edit and `extractAssistantText` already do; the preview
                // did not, so the user watched the model's chain of thought
                // appear and then vanish. While only reasoning has arrived there
                // is nothing to show, and a bare cursor is not a message: wait
                // for real text rather than sending one.
                const preview = stripPartialThinkTags(accumulated);
                if (!preview) continue;
                const displayText = `${clampStreamPreview(preview)} ▌`;
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
          if (streamedToolCalls.length > 0 && !forceTextOnly) {
            let adopted = false;
            if (sentKey && !streamingFailed) {
              adopted = progressTracker.adoptMessageKey(sentKey);
            }
            if (sentKey && !streamingFailed && !adopted) {
              // The tracker already owns an earlier bubble, so this one is never
              // edited again — and it still ends in the streaming cursor. Finalise
              // it here so the user is not left looking at a dangling "▌".
              await ctx.editMessage!(sentKey, stripThinkTags(accumulated) || '…').catch((err: unknown) => {
                log.warn({ err: getErrorMessage(err), chatId }, '[Agent] Failed to finalise an intermediate streamed bubble');
              });
            }
            streamedResponseSent = false;
            // The bubble is now owned by the tracker or finalised above; a later
            // throw in tool execution must not overwrite it with the cursor-strip.
            finalizeStreamedBubble = null;

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
            if (accumulated.trim()) lastAssistantText = stripThinkTags(accumulated);

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
              progressTracker,
              accessContext,
            });
            preferredTier = execution.preferredTier;
            messagesForAI.push(...execution.toolResults);
            continue; // Loop again for the next LLM call
          }

          // Stream produced only text — we are done
          isDone = true;
          finalAiResponseText = stripThinkTags(accumulated)
            || (forceTextOnly ? lastAssistantText : '')
            || internalErrorText;

          // Final edit to remove cursor indicator
          if (sentKey && finalAiResponseText !== internalErrorText && !streamingFailed) {
            try {
              await ctx.editMessage!(sentKey, finalAiResponseText);
            } catch (err: unknown) {
              // The edit that removes the cursor is what turns the streamed
              // message into the final answer. If it fails, treating the reply as
              // delivered left the user on a truncated stream still ending in ▌
              // (and recorded the full text as sent). Route it through the same
              // `streamingFailed` fallback as a failed intermediate edit, so a
              // regular reply follows with the complete text.
              log.warn({ err: getErrorMessage(err), chatId, mode: 'stream_final' }, '[Agent] Final streaming edit failed');
              streamingFailed = true;
            }
          }

          // If an intermediate edit/send already failed, fall through to a
          // regular ctx.reply so the user still receives the final text.
          if (streamingFailed) {
            streamedResponseSent = false;
          }
          // The bubble has been finalised (or a regular reply will follow).
          finalizeStreamedBubble = null;

          continue;
        }

        // ── Non-streaming (original) path ───────────────────────────────────
        const aiMsgObj: ChatCompletionMessage = await modelRouter.chatCompletion(
          iterationMessages, iterationTools, config.temperature, config.maxTokens, preferredTier,
        );

        // Remember any usable text from this step: if the final, forced round
        // returns no content (some models still emit a tool call), this is a
        // better answer than the internal-error text.
        const stepText = extractAssistantText(aiMsgObj);
        if (stepText) lastAssistantText = stepText;

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

        if (aiMsgObj.tool_calls && aiMsgObj.tool_calls.length > 0 && !forceTextOnly) {
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
            progressTracker,
            accessContext,
          });
          preferredTier = execution.preferredTier;
          messagesForAI.push(...execution.toolResults);
        } else {
          // Standard text response (terminal state)
          isDone = true;
          finalAiResponseText = extractAssistantText(aiMsgObj) || (forceTextOnly ? lastAssistantText : '');
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
        // Strip the streaming cursor from a bubble that was already posted before
        // this failure, so the fallback reply does not sit under a message that
        // still looks like it is being written.
        await finalizeStreamedBubble?.();
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
      finalAiResponseText = lastAssistantText || internalErrorText;
    }

    // 4. Save Final AI Response
    await db.insert(messages).values({
      chatRoomId: roomId,
      ...messageRoomKeyInsertValues(roomIdentity.roomKey),
      senderId: 'bot',
      senderName: BOT_NAME,
      role: 'assistant',
      content: finalAiResponseText,
      platform,
      created_at: new Date(),
    });

    const replyAlreadyDelivered = streamedResponseSent && finalAiResponseText !== internalErrorText;
    const keyParts = outboxKeyParts(ctx.messageId, 'assistant', ctx.chatId);
    if (replyAlreadyDelivered) {
      OutboxService.recordTextDelivered(platform, chatId, finalAiResponseText, keyParts);
    } else {
      const deliveryId = OutboxService.enqueueDirectText(
        platform,
        chatId,
        finalAiResponseText,
        keyParts,
      );
      try {
        const result = await withCancellableTimeout(
          signal => ctx.reply(finalAiResponseText, { signal }),
          DIRECT_SEND_TIMEOUT_MS,
          'direct reply',
          ctx.signal,
        );
        const providerMessageId = typeof result === 'string' ? result : null;
        const recorded = OutboxService.markEnqueuedSent(deliveryId, providerMessageId);
        if (!recorded) {
          log.warn({ deliveryId, chatId }, 'Final reply raced the outbox poller; delivery row was already claimed');
        }
      } catch (error) {
        log.warn({ err: error, deliveryId }, 'Immediate delivery failed; outbox will retry');
      }
    }
    await ctx.react?.('✅').catch(err => log.warn({ err, chatId }, '[Agent] Reaction failed'));
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
    };
    if (usedFallbackError) {
      log.warn(logPayload, 'Successfully responded');
    } else {
      log.info(logPayload, 'Successfully responded');
    }

  } catch (error) {
    log.error(error, 'Error handling message');
    healthMetrics.recordMessageError();
    await ctx.react?.('❌').catch(err => log.warn({ err, chatId }, '[Agent] Reaction failed')); // show error
    await deliverDurableText(ctx, t(ctx.language, 'agent.internal_error'), 'agent:fatal');
  }
}
