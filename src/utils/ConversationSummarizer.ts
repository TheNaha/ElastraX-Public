/**
 * @file src/utils/ConversationSummarizer.ts
 * @description Compresses old conversation history into a rolling summary.
 *
 * When a chat room's message history exceeds the configured context limit,
 * instead of blindly dropping the oldest messages (losing important context),
 * the summarizer:
 *   1. Takes the oldest 50% of messages that fall outside the active window.
 *   2. Calls the LLM to compress them into a concise, factual summary paragraph.
 *   3. Injects the summary as a special system-level message at the top of the
 *      history so the bot "remembers" earlier parts of the conversation.
 *   4. Stores the summary in the `chat_rooms` table's `summaryCache` column
 *      (if present) to avoid re-summarizing on every request.
 *
 * This gives the bot effective long-term memory without burning tokens on
 * the full history.
 */

import type { AIChatMessage } from '../ai/client';
import { logger } from './logger';

export interface SummaryResult {
  /** The compressed summary text to inject into prompts. */
  summary: string;
  /** The trimmed active history window to keep verbatim. */
  activeHistory: AIChatMessage[];
}

/**
 * Given a full ordered message list and the target context window size,
 * returns a compressed summary plus the most-recent messages unmodified.
 *
 * @param fullHistory  All messages in chronological order (oldest first).
 * @param contextLimit Max number of messages to keep verbatim in the active window.
 * @param callLLM      Function to call the LLM for summarization (injected to avoid circular deps).
 * @returns            A `SummaryResult` or null if summarization is not needed.
 */
export async function summarizeHistory(
  fullHistory: AIChatMessage[],
  contextLimit: number,
  callLLM: (messages: AIChatMessage[]) => Promise<string>,
): Promise<SummaryResult | null> {
  // Only summarize if we have substantially more history than the active window
  const OVERFLOW_THRESHOLD = Math.floor(contextLimit * 1.5);
  if (fullHistory.length <= OVERFLOW_THRESHOLD) {
    return null;
  }

  // Split: old messages → summarize, recent messages → keep verbatim
  const splitPoint = fullHistory.length - contextLimit;
  const oldMessages = fullHistory.slice(0, splitPoint);
  const activeHistory = fullHistory.slice(splitPoint);

  logger.info(
    { totalMessages: fullHistory.length, summarizing: oldMessages.length, keeping: activeHistory.length },
    '[Summarizer] Compressing conversation history',
  );

  // Build a summarization prompt from the old messages
  const historyText = oldMessages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const roleLabel = m.role === 'user' ? 'User' : 'Assistant';
      const content = typeof m.content === 'string'
        ? m.content
        : (m.content as any[]).find((p: any) => p.type === 'text')?.text ?? '[media]';
      return `${roleLabel}: ${content.slice(0, 400)}`;
    })
    .join('\n');

  const summarizationMessages: AIChatMessage[] = [
    {
      role: 'system',
      content: 'You are a summarization assistant. Produce a concise, factual 3-5 sentence summary of the conversation below. Focus on key topics, decisions, facts shared, and user preferences. Do NOT include greetings or filler. Write in third person.',
    },
    {
      role: 'user',
      content: `Conversation to summarize:\n\n${historyText}`,
    },
  ];

  try {
    const summary = await callLLM(summarizationMessages);
    logger.debug({ summaryLength: summary.length }, '[Summarizer] Summary generated');
    return { summary, activeHistory };
  } catch (err) {
    logger.error({ err }, '[Summarizer] Failed to generate summary, falling back to truncation');
    // Graceful fallback: just return the active window without a summary
    return { summary: '', activeHistory };
  }
}
