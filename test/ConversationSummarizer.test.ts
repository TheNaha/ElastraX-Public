import { describe, expect, mock, test } from 'bun:test';

mock.module('../src/utils/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  },
}));

import {
  ConversationSummaryService,
  summarizeHistory,
  type SummaryEntry,
  type SummaryStore,
  type SummaryWatermark,
} from '../src/utils/ConversationSummarizer';
import type { AIChatMessage } from '../src/ai/client';

function makeMessages(count: number): AIChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Message ${index + 1}`,
  }));
}

class MemorySummaryStore implements SummaryStore {
  readonly values = new Map<string, SummaryWatermark>();

  async load(scope: string): Promise<SummaryWatermark | null> {
    return this.values.get(scope) ?? null;
  }

  async save(scope: string, watermark: SummaryWatermark): Promise<void> {
    this.values.set(scope, watermark);
  }
}

function entries(count: number): SummaryEntry[] {
  return makeMessages(count).map((message, index) => ({ id: String(index + 1), message }));
}

describe('summarizeHistory', () => {
  test('returns null when history fits the context limit', async () => {
    const callLLM = mock(async () => 'summary');
    expect(await summarizeHistory(makeMessages(10), 10, callLLM)).toBeNull();
    expect(callLLM).not.toHaveBeenCalled();
  });

  test('summarizes immediately after the context limit is exceeded', async () => {
    const callLLM = mock(async () => 'summary');
    const result = await summarizeHistory(makeMessages(11), 10, callLLM);
    expect(result?.activeHistory).toHaveLength(10);
    expect(result?.activeHistory[9]?.content).toBe('Message 11');
    expect(callLLM).toHaveBeenCalledTimes(1);
  });

  test('keeps the newest context when summary generation fails', async () => {
    const result = await summarizeHistory(
      makeMessages(11),
      10,
      async () => { throw new Error('failed'); },
    );
    expect(result).not.toBeNull();
    expect(result?.summary).toBe('');
    expect(result?.activeHistory).toHaveLength(10);
  });
});

describe('ConversationSummaryService', () => {
  test('persists and advances a room watermark using the prior summary', async () => {
    const store = new MemorySummaryStore();
    const service = new ConversationSummaryService(store);
    const allEntries = entries(6);

    const first = await service.summarize({
      scope: 'room-1',
      entries: allEntries,
      keepCount: 2,
      callLLM: async () => 'first summary',
    });
    expect(first.changed).toBe(true);
    expect(first.watermark?.throughMessageId).toBe('4');
    expect(first.summarizedCount).toBe(4);
    expect(first.activeHistory.map(message => message.content)).toEqual(['Message 5', 'Message 6']);

    let prompt = '';
    const nextMessage: AIChatMessage = { role: 'user', content: 'Message 7' };
    const second = await service.summarize({
      scope: 'room-1',
      entries: [...allEntries.filter(entry => entry.id !== '4'), { id: '7', message: nextMessage }],
      keepCount: 2,
      callLLM: async messages => {
        prompt = String(messages[1]?.content);
        return 'updated summary';
      },
    });
    expect(prompt).toContain('first summary');
    expect(second.watermark?.throughMessageId).toBe('5');
    expect(second.summarizedCount).toBe(1);
    expect(second.changed).toBe(true);
    expect(second.summary).toBe('updated summary');
  });

  test('does not advance the watermark when generation fails', async () => {
    const store = new MemorySummaryStore();
    const service = new ConversationSummaryService(store);
    const failed = await service.summarize({
      scope: 'room-2',
      entries: entries(5),
      keepCount: 2,
      callLLM: async () => { throw new Error('unavailable'); },
    });
    expect(failed.changed).toBe(false);
    expect(failed.watermark).toBeNull();
    expect(await service.getWatermark('room-2')).toBeNull();
  });
});
