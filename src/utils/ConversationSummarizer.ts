import type { AIChatMessage, AIContentPart } from '../ai/client';
import { logger } from './logger';

export interface SummaryResult {
  summary: string;
  activeHistory: AIChatMessage[];
}

export async function summarizeHistory(
  fullHistory: AIChatMessage[],
  contextLimit: number,
  callLLM: (messages: AIChatMessage[]) => Promise<string>,
): Promise<SummaryResult | null> {
  const overflowThreshold = Math.floor(contextLimit * 2);
  if (fullHistory.length <= overflowThreshold) {
    return null;
  }

  const splitPoint = fullHistory.length - contextLimit;
  const oldMessages = fullHistory.slice(0, splitPoint);
  const activeHistory = fullHistory.slice(splitPoint);

  logger.info(
    { totalMessages: fullHistory.length, summarizing: oldMessages.length, keeping: activeHistory.length },
    '[Summarizer] Compressing conversation history',
  );

  const historyText = oldMessages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => {
      const roleLabel = message.role === 'user' ? 'User' : 'Assistant';
      const content = typeof message.content === 'string'
        ? message.content
        : message.content.find((part: AIContentPart) => part.type === 'text')?.text ?? '[media]';
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
  } catch (error: unknown) {
    logger.error({ err: error }, '[Summarizer] Failed to generate summary, falling back to truncation');
    return { summary: '', activeHistory };
  }
}
