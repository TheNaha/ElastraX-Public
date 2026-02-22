import { db } from '../db';
import { chatRooms, messages } from '../db/schema';
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

const aiClient = new AIClient();

const DEFAULT_SYSTEM_PROMPT = `You are ElastraX, a helpful and friendly female AI personal assistant.
You are communicating via a messaging app (WhatsApp/Discord).
If someone asks your name or identity, strictly introduce yourself as ElastraX.
Be concise but warmly conversational. Use emojis naturally where appropriate, but don't overdo it.
Do not use markdown formatting that is not supported by WhatsApp (e.g. headers). Bold and italic are fine.
If a user asks a question requiring recent information, facts, or news, you MUST use the "web_search" tool to find the answer.
When using "web_search", always provide a summary of the findings first, and then explicitly provide a list of the source URLs you used at the bottom of your message.

CRITICAL LOCALIZATION INSTRUCTION:
You MUST respond entirely in the language specified by the user's chat room setting.
Current Room Language: {{LANGUAGE}}`;

export async function handleIncomingMessage(ctx: MessageContext): Promise<void> {
  const { chatId, platform, senderName, text, isGroup, mentionedIds } = ctx;

  // We will always process the message to save it to context history
  // But we use this flag to decide if the AI should actually generate a reply
  let shouldTriggerAI = !isGroup;

  if (isGroup) {
    if (text.toLowerCase().startsWith('/chat') || text.startsWith('/')) {
      shouldTriggerAI = true;
    }
    // Check if the bot was explicitly mentioned using its ID.
    // mentionedIds contains the JIDs of tagged users.
    // For WhatsApp, the bot's JID would be in that array if tagged.
    // Since we don't have the bot's exact JID exported everywhere easily, 
    // we'll rely on text inclusion of the bot's name or any mentioned IDs.
    // For a more robust approach: if mentionedIds has items, we assume it *might* be for us if the text implies it,
    // OR just trigger if mentionedIds is not empty (as a test) and refine later if it triggers on other people's tags.
    // Alternatively, if the text contains @ElastraX or similar.
    if (mentionedIds && mentionedIds.length > 0) {
      // Assuming if the bot is tagged, it's meant to reply
      shouldTriggerAI = true;
    }
    // Check if the user is replying to a message originally sent by the bot
    if (ctx.quoted?.rawMessage?.key?.fromMe) {
      shouldTriggerAI = true;
    }
  }

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
    room = newRoom as any;
  }
  ctx.language = room.language;

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

    // 1. Save User Message
    await db.insert(messages).values({
      chatRoomId: chatId,
      senderId: ctx.senderId,
      senderName,
      role: 'user',
      content: userContent,
      providerMessageId: ctx.messageId,
      rawMessage: JSON.stringify(ctx.rawMessage),
      mediaPath: ctx.mediaPath,
      mimeType: ctx.mimeType,
      created_at: new Date(),
    });

    // 2. Retrieve Context (last 10 messages)
    const history = await db.select()
      .from(messages)
      .where(eq(messages.chatRoomId, chatId))
      .orderBy(desc(messages.created_at))
      .limit(10);
    
    // Reverse to put chronological order back
    history.reverse();

    // Assemble system prompt with localized injection
    const systemPromptText = (room.systemPrompt || DEFAULT_SYSTEM_PROMPT).replace('{{LANGUAGE}}', langFull);
    
    // Assemble AI context
    const messagesForAI: AIChatMessage[] = [
      { role: 'system', content: systemPromptText }
    ];

    for (const m of history) {
      const textPrefix = m.role === 'user' ? `[${m.senderName}]: ` : '';
      const textContent = textPrefix + m.content;
      
      let finalContent: AIChatMessage['content'] = textContent;

      // Handle multimodal vision if message has media
      if (m.mediaPath && m.mimeType?.startsWith('image/')) {
        if (existsSync(m.mediaPath)) {
          try {
            const fileBuffer = await readFile(m.mediaPath);
            const base64Data = fileBuffer.toString('base64');
            const dataUri = `data:${m.mimeType};base64,${base64Data}`;
            
            finalContent = [
              { type: 'text', text: textContent },
              { type: 'image_url', image_url: { url: dataUri } }
            ];
          } catch (err) {
            logger.error({ err, path: m.mediaPath }, 'Failed to read media for AI context');
          }
        }
      }

      messagesForAI.push({
        role: m.role as 'user' | 'assistant',
        content: finalContent,
      });
    }

    // 3. Check if we should actually generate a response
    if (!shouldTriggerAI) {
       // Since it's casual chatter, we saved it to context, but we don't reply!
       return; 
    }

    // 4. Generate AI Response (Recursive for tools)
    await ctx.react?.('⏳');
    
    let isDone = false;
    let finalAiResponseText = '';
    const availableTools = getToolDefinitions();

    while (!isDone) {
      try {
        const aiMsgObj = await aiClient.chatCompletion(messagesForAI, availableTools);

        // Append the AI's step back to the context
        messagesForAI.push(aiMsgObj);

        if (aiMsgObj.tool_calls && aiMsgObj.tool_calls.length > 0) {
          // Tool Call Requested
          for (const tc of aiMsgObj.tool_calls) {
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

            // Append tool response
            messagesForAI.push({
              role: 'tool',
              tool_call_id: tc.id,
              name: toolName,
              content: toolResultStr,
            });
          }
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
