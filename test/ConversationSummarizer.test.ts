import { describe, expect, mock, test } from 'bun:test';

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

/**
 * The agent re-fetches a rolling history window on every turn, so only the few
 * messages that fell out of that window are new. Folding that handful
 * immediately put a model call on *every* inbound message in every summarizing
 * room — and each call re-carried the entire rolling summary as its prompt
 * prefix, so cost per call grew with the conversation.
 *
 * These use the real window arithmetic the agent uses (context limit + lookahead)
 * and count the model calls.
 */
describe('summarization batching', () => {
  const keepCount = 10;
  const lookahead = 16;
  const minBatch = 8;

  function rollingWindowService() {
    let saved: SummaryWatermark | null = null;
    const store: SummaryStore = {
      load: async () => saved,
      save: async (_scope, watermark) => { saved = watermark; },
      delete: async () => { saved = null; },
    };
    return new ConversationSummaryService(store);
  }

  test('does not call the model on every turn', async () => {
    const service = rollingWindowService();
    let llmCalls = 0;
    const callLLM = async (): Promise<string> => {
      llmCalls += 1;
      return `summary ${llmCalls}`;
    };
    const window: SummaryEntry[] = [];
    let maxActive = 0;

    for (let turn = 0; turn < 12; turn += 1) {
      for (let added = 0; added < 2; added += 1) {
        window.push({ id: String(window.length + 1), message: { role: 'user', content: `m${window.length}` } });
      }
      const slice = window.slice(-(keepCount + lookahead));
      const run = await service.summarize({ scope: 'room:batch', entries: slice, keepCount, minBatch, callLLM });
      maxActive = Math.max(maxActive, run.activeHistory.length);
    }

    expect(llmCalls).toBeGreaterThan(0);
    expect(llmCalls).toBeLessThanOrEqual(2);
    // A deferred overflow is smaller than minBatch, so the window can never carry
    // more than keepCount + minBatch - 1; it must not silently drop entries.
    expect(maxActive).toBeLessThanOrEqual(keepCount + minBatch - 1);
  });

  test('a large batch is still summarized immediately', async () => {
    const service = rollingWindowService();
    let llmCalls = 0;
    const callLLM = async (): Promise<string> => {
      llmCalls += 1;
      return 'summary';
    };
    const entries: SummaryEntry[] = Array.from({ length: keepCount + 20 }, (_, index) => ({
      id: String(index + 1),
      message: { role: 'user', content: `m${index}` },
    }));
    const run = await service.summarize({ scope: 'room:bulk', entries, keepCount, minBatch, callLLM });
    expect(llmCalls).toBe(1);
    expect(run.summarizedCount).toBe(20);
    expect(run.activeHistory).toHaveLength(keepCount);
  });

  test('a failing summary store load does not abort the turn', async () => {
    // The previous summary is an optimisation, not a prerequisite. A transient
    // app_kv read error used to propagate out of summarize() and turn every
    // message in the room into "internal error".
    const store: SummaryStore = {
      load: async () => { throw new Error('app_kv unavailable'); },
      save: async () => {},
      delete: async () => {},
    };
    const service = new ConversationSummaryService(store);
    const entries: SummaryEntry[] = Array.from({ length: keepCount + 2 }, (_, index) => ({
      id: String(index + 1),
      message: { role: 'user', content: `m${index}` },
    }));
    const callLLM = mock(async (): Promise<string> => 'summary');

    const run = await service.summarize({ scope: 'room:load-fail', entries, keepCount, minBatch, callLLM });

    expect(callLLM).not.toHaveBeenCalled();
    expect(run.activeHistory).toHaveLength(entries.length);
    expect(run.summary).toBe('');
  });

  test('entries below the threshold are carried forward, not dropped', async () => {
    const service = rollingWindowService();
    const callLLM = mock(async (): Promise<string> => 'summary');
    const entries: SummaryEntry[] = Array.from({ length: keepCount + 2 }, (_, index) => ({
      id: String(index + 1),
      message: { role: 'user', content: `m${index}` },
    }));
    const first = await service.summarize({ scope: 'room:carry', entries, keepCount, minBatch, callLLM });
    expect(callLLM).not.toHaveBeenCalled();
    // The watermark must not advance, or the carried entries would be lost.
    expect(first.watermark).toBeNull();
    // And every un-summarized entry is still visible in the active window: the
    // overflow used to be sliced off before the threshold was applied, so the
    // two oldest messages were neither summarized nor sent to the model.
    expect(first.activeHistory).toHaveLength(entries.length);
    expect(first.activeHistory).toEqual(entries.map(entry => entry.message));
  });
});
