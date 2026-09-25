import type { AIChatMessage, AIContentPart } from '../ai/client';
import { logger } from './logger';

export interface SummaryResult {
  summary: string;
  activeHistory: AIChatMessage[];
}

export interface SummaryEntry {
  id: string;
  message: AIChatMessage;
}

export interface SummaryWatermark {
  version: 1;
  scope: string;
  throughMessageId: string;
  summarizedMessages: number;
  summary: string;
  updatedAt: string;
}

export interface SummaryStore {
  load(scope: string): Promise<SummaryWatermark | null>;
  save(scope: string, watermark: SummaryWatermark): Promise<void>;
  delete?(scope: string): Promise<void>;
}

export interface ConversationSummaryRequest {
  scope: string;
  entries: readonly SummaryEntry[];
  keepCount: number;
  callLLM: (messages: AIChatMessage[]) => Promise<string>;
}

export interface ConversationSummaryRun extends SummaryResult {
  changed: boolean;
  summarizedCount: number;
  watermark: SummaryWatermark | null;
}

function messageText(message: AIChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  const parts = message.content as AIContentPart[];
  return parts
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join(' ')
    .slice(0, 400) || '[media]';
}

export function buildSummaryMessages(
  entries: readonly SummaryEntry[],
  previousSummary?: string,
): AIChatMessage[] {
  const historyText = entries
    .filter(entry => entry.message.role === 'user' || entry.message.role === 'assistant')
    .map(entry => {
      const label = entry.message.role === 'user' ? 'User' : 'Assistant';
      return `${label}: ${messageText(entry.message)}`;
    })
    .join('\n');
  const prior = previousSummary?.trim()
    ? `Existing rolling summary:\n${previousSummary.trim()}\n\n`
    : '';
  return [
    {
      role: 'system',
      content: 'You are a summarization assistant. Produce a concise, factual 3-5 sentence rolling summary. Include prior facts, decisions, user preferences, and new conversation facts. Do not include greetings or filler. Write in third person.',
    },
    {
      role: 'user',
      content: `${prior}New conversation turns to incorporate:\n\n${historyText}`,
    },
  ];
}

function validateKeepCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function entriesAfterWatermark(
  entries: readonly SummaryEntry[],
  previous: SummaryWatermark | null,
): SummaryEntry[] {
  if (!previous) return [...entries];
  const watermarkIndex = entries.findIndex(entry => entry.id === previous.throughMessageId);
  if (watermarkIndex >= 0) return entries.slice(watermarkIndex + 1);
  if (
    entries.length > 0
    && /^\d+$/.test(previous.throughMessageId)
    && entries.every(entry => /^\d+$/.test(entry.id))
  ) {
    const through = BigInt(previous.throughMessageId);
    return entries.filter(entry => BigInt(entry.id) > through);
  }
  return [...entries];
}

export class ConversationSummaryService {
  constructor(private readonly store: SummaryStore) {}

  getWatermark(scope: string): Promise<SummaryWatermark | null> {
    return this.store.load(scope);
  }

  async summarize(request: ConversationSummaryRequest): Promise<ConversationSummaryRun> {
    const keepCount = validateKeepCount(request.keepCount);
    const previous = await this.store.load(request.scope);
    const entries = entriesAfterWatermark(request.entries, previous);
    const activeEntries = entries.slice(-keepCount);
    const summarizedEntries = entries.slice(0, Math.max(0, entries.length - keepCount));

    if (summarizedEntries.length === 0) {
      return {
        summary: previous?.summary ?? '',
        activeHistory: activeEntries.map(entry => entry.message),
        changed: false,
        summarizedCount: 0,
        watermark: previous,
      };
    }

    logger.info(
      {
        scope: request.scope,
        totalEntries: entries.length,
        summarizing: summarizedEntries.length,
        keeping: activeEntries.length,
      },
      '[Summarizer] Compressing conversation history',
    );

    try {
      const generated = (await request.callLLM(
        buildSummaryMessages(summarizedEntries, previous?.summary),
      )).trim();
      if (!generated) throw new Error('Summarizer returned an empty summary.');
      const watermark: SummaryWatermark = {
        version: 1,
        scope: request.scope,
        throughMessageId: summarizedEntries[summarizedEntries.length - 1]!.id,
        summarizedMessages: (previous?.summarizedMessages ?? 0) + summarizedEntries.length,
        summary: generated,
        updatedAt: new Date().toISOString(),
      };
      await this.store.save(request.scope, watermark);
      return {
        summary: generated,
        activeHistory: activeEntries.map(entry => entry.message),
        changed: true,
        summarizedCount: summarizedEntries.length,
        watermark,
      };
    } catch (error: unknown) {
      logger.error({ err: error }, '[Summarizer] Summary generation failed; watermark was not advanced');
      return {
        summary: previous?.summary ?? '',
        activeHistory: activeEntries.map(entry => entry.message),
        changed: false,
        summarizedCount: 0,
        watermark: previous,
      };
    }
  }
}

export async function summarizeHistory(
  fullHistory: AIChatMessage[],
  contextLimit: number,
  callLLM: (messages: AIChatMessage[]) => Promise<string>,
): Promise<SummaryResult | null> {
  const keepCount = validateKeepCount(contextLimit);
  if (fullHistory.length <= keepCount) return null;
  const splitPoint = fullHistory.length - keepCount;
  const oldMessages = fullHistory.slice(0, splitPoint);
  const activeHistory = fullHistory.slice(splitPoint);
  const entries = oldMessages.map((message, index) => ({ id: String(index), message }));

  try {
    const summary = (await callLLM(buildSummaryMessages(entries))).trim();
    return { summary, activeHistory };
  } catch (error: unknown) {
    logger.error({ err: error }, '[Summarizer] Failed to generate summary, falling back to truncation');
    return { summary: '', activeHistory };
  }
}
