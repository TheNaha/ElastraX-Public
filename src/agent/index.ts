import { db } from '../db';
import { chatRooms, messages } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { MessageContext } from '../core/MessageContext';
import { AIClient, AIChatMessage } from '../ai/client';
import { logger } from '../utils/logger';
import { getToolDefinitions, getToolByName, getToolByAliasOrName } from '../tools';
import { ParameterValidator } from '../utils/ParameterValidator';
import { FlowHandler } from '../core/FlowHandler';

const aiClient = new AIClient();

const DEFAULT_SYSTEM_PROMPT = `You are Elastra BOT, a helpful, concise AI personal assistant. 
You are communicating via a messaging app (WhatsApp/Discord).
Keep your answers relatively short unless asked for detail. Use formatting where appropriate.
If a user asks a question requiring recent information, facts, or news, you MUST use the "web_search" tool to find the answer.
When using "web_search", always provide a summary of the findings first, and then explicitly provide a list of the source URLs you used at the bottom of your message.`;

export async function handleIncomingMessage(ctx: MessageContext): Promise<void> {
  const { chatId, platform, senderName, text, isGroup, mentionedIds } = ctx;

  if (isGroup) {
    if (!text.toLowerCase().startsWith('/chat') && !text.startsWith('/')) {
      return; // Ignore general group chatter unless explicitly commanded
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

    // If an unknown command is issued, we can optionally warn the user
    await ctx.reply(`Unknown command: /${command}`);
    return;
  }

  // Clean the text for conversational flow
  const userContent = isGroup && text.toLowerCase().startsWith('/chat') 
    ? text.substring(5).trim() 
    : text;

  if (!userContent) return;

  const chatType = isGroup ? 'Group' : 'Private';
  logger.info(`[WhatsApp | ${chatType}] ${senderName} (${chatId}): ${userContent}`);

  try {
    // 1. Ensure ChatRoom exists
    const roomRecord = await db.select().from(chatRooms).where(eq(chatRooms.id, chatId));
    if (roomRecord.length === 0) {
      await db.insert(chatRooms).values({
        id: chatId,
        platform,
        created_at: new Date(),
      });
    }

    // 2. Save User Message
    await db.insert(messages).values({
      chatRoomId: chatId,
      senderId: ctx.senderId,
      senderName,
      role: 'user',
      content: userContent,
      rawMessage: JSON.stringify(ctx.rawMessage),
      created_at: new Date(),
    });

    // 3. Retrieve Context (last 10 messages)
    const history = await db.select()
      .from(messages)
      .where(eq(messages.chatRoomId, chatId))
      .orderBy(desc(messages.created_at))
      .limit(10);
    
    // Reverse to put chronological order back
    history.reverse();

    const formattedMessages: AIChatMessage[] = [
      { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
      ...history.map(m => ({
        role: m.role as 'user' | 'assistant',
        // Prepend sender name for group context if user
        content: m.role === 'user' ? `[${m.senderName}]: ${m.content}` : m.content,
      }))
    ];

    // 4. Generate AI Response (Recursive for tools)
    await ctx.react?.('⏳');
    
    let isDone = false;
    let finalAiResponseText = '';
    const availableTools = getToolDefinitions();

    while (!isDone) {
      try {
        const aiMsgObj = await aiClient.chatCompletion(formattedMessages, availableTools);

        // Append the AI's step back to the context
        formattedMessages.push(aiMsgObj);

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
            formattedMessages.push({
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

    // 5. Save Final AI Response
    await db.insert(messages).values({
      chatRoomId: chatId,
      senderId: 'bot',
      senderName: 'ElastraGPBOT',
      role: 'assistant',
      content: finalAiResponseText,
      created_at: new Date(),
    });

    // 6. Send Response
    await ctx.reply(finalAiResponseText);
    await ctx.react?.('✅'); // show success
    logger.info({ chatId }, 'Successfully responded');

  } catch (error) {
    logger.error(error, 'Error handling message');
    await ctx.react?.('❌'); // show error
    await ctx.reply('An internal error occurred while processing your message.');
  }
}
