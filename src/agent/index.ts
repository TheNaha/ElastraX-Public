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
 *     LLM inference loop (which may invoke tools recursively).
 *  6. Persist the final assistant reply and send it back to the user.
 */

import { db } from '../db';
import { chatRooms, messages, ChatRoom } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { MessageContext } from '../core/MessageContext';
import { AIClient, AIChatMessage } from '../ai/client';
import { logger } from '../utils/logger';
import { getToolDefinitions, getToolByName, getToolByAliasOrName } from '../tools';
import { ParameterValidator } from '../utils/ParameterValidator';
import { FlowHandler } from '../core/FlowHandler';
import { t } from '../utils/i18n';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { ConfigService } from '../utils/ConfigService';

// Module-level AI client instance — created once and reused for all messages.
const aiClient = new AIClient();


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

  // Fetch or create the chat room early so that ctx.language is available to all
  // tools and flow handlers before any routing takes place.
  let room = (await db.select().from(chatRooms).where(eq(chatRooms.id, chatId)))[0];
  if (!room) {
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
      allowTools: null,
      autoReplyAll: null,
    };
  }
  ctx.language = room.language;

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
    if (mentionedIds && mentionedIds.length > 0) {
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

    logger.info(`[Command Router] Received command: /${command} with query: "${queryStr}"`);

    // Map explicit commands dynamically
    const tool = getToolByAliasOrName(command);
    if (tool) {
      // Check permissions
      const hasPermission = await ctx.checkPermissions(tool.permissions);
      if (!hasPermission) {
        await ctx.reply(t(ctx.language, 'agent.no_permission'));
        return;
      }

      await ctx.react?.('🔍');
      try {
        const parsedArgs = ParameterValidator.parseArgs(tool, queryStr);
        const result = await tool.execute(parsedArgs, ctx);
        await ctx.reply(result);
        await ctx.react?.('✅');
      } catch (err: any) {
        await ctx.reply(err.message);
        await ctx.react?.('❌');
      }
      return;
    }

    // If an unknown command is issued, warn the user in their language
    await ctx.reply(t(ctx.language, 'agent.unknown_command', { cmd: command }));
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
  logger.info(`[WhatsApp | ${chatType}] ${senderName} (${chatId}): ${userContent || '<media only>'}`);

  try {
    // Room is already fetched above; derive the language label for the system prompt.
    const langFull = room.language === 'id' ? 'Indonesian (Bahasa Indonesia)' : 'English';

    // 1. Save User Message (idempotent - Baileys can emit the same message event twice on reconnect/history sync)
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
          logger.error({ err }, 'Failed to sync DB with downloaded media paths');
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
    // Optimization: Select only necessary columns to avoid fetching large 'rawMessage' blobs
    const history = await db.select({
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
      .limit(config.contextLimit);
    
    // Reverse to put chronological order back
    history.reverse();

    // Assemble system prompt with localized injection
    const systemPromptText = config.systemPrompt.replace('{{LANGUAGE}}', langFull);
    
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
          logger.error({ err, path: mediaPath }, 'Failed to read media for AI context');
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

    // 4. Generate AI Response (Recursive for tools)
    await ctx.react?.('⏳');
    
    let isDone = false;
    let finalAiResponseText = '';
    const availableTools = config.allowTools ? getToolDefinitions() : undefined;

    while (!isDone) {
      try {
        const aiMsgObj = await aiClient.chatCompletion(messagesForAI, availableTools, config.temperature);

        // Append the AI's step back to the context
        messagesForAI.push(aiMsgObj);

        if (aiMsgObj.tool_calls && aiMsgObj.tool_calls.length > 0) {
          // Tool Call Requested - Parallel Execution
          const toolPromises = aiMsgObj.tool_calls.map(async (tc: any) => {
            const toolName = tc.function.name;
            let args = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch (e) {
              logger.warn({ raw: tc.function.arguments }, 'Failed to parse tool arguments');
            }

            const tool = getToolByName(toolName);
            let toolResultStr = '';
            
            if (tool) {
              logger.info(`[Agent] Invoked tool: ${toolName} with args: ${JSON.stringify(args)}`);
              await ctx.react?.('🔍'); // Feedback to user
              toolResultStr = await tool.execute(args, ctx);
            } else {
              logger.error({ toolName }, 'LLM requested unknown tool');
              toolResultStr = `Error: Tool ${toolName} not found.`;
            }

            return {
              role: 'tool',
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
          finalAiResponseText = aiMsgObj.content || '';
        }

      } catch (e) {
        logger.error(e, 'Failed to get AI completion / execute tool');
        finalAiResponseText = "I'm sorry, I encountered an error during inference.";
        isDone = true;
      }
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
    await ctx.reply(finalAiResponseText);
    await ctx.react?.('✅'); // show success
    logger.info({ chatId }, 'Successfully responded');

  } catch (error) {
    logger.error(error, 'Error handling message');
    await ctx.react?.('❌'); // show error
    await ctx.reply(t(ctx.language, 'agent.internal_error'));
  }
}
