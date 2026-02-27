import { describe, test, expect, mock } from 'bun:test';

mock.module('../src/utils/logger', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) },
}));

import { summarizeHistory } from '../src/utils/ConversationSummarizer';
import type { AIChatMessage } from '../src/ai/client';

function makeMessages(count: number): AIChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Message ${i + 1}`,
  }));
}

describe('ConversationSummarizer', () => {
  test('returns null when history <= contextLimit * 10', async () => {
    const contextLimit = 10;
    // With multiplier 10, threshold is 100
    const history = makeMessages(100);
    const callLLM = mock(async () => 'summary');
    const result = await summarizeHistory(history, contextLimit, callLLM);
    expect(result).toBeNull();
    expect(callLLM).not.toHaveBeenCalled();
  });

  test('returns null when history is exactly at threshold', async () => {
    const contextLimit = 10;
    const threshold = Math.floor(contextLimit * 10);
    const history = makeMessages(threshold);
    const callLLM = mock(async () => 'summary');
    const result = await summarizeHistory(history, contextLimit, callLLM);
    expect(result).toBeNull();
  });

  test('returns SummaryResult when history > contextLimit * 10', async () => {
    const contextLimit = 10;
    // Threshold is 100, so 101 should trigger summarization
    const history = makeMessages(101);
    const callLLM = mock(async () => 'This is the summary.');
    const result = await summarizeHistory(history, contextLimit, callLLM);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('This is the summary.');
    expect(result!.activeHistory).toHaveLength(contextLimit);
  });

  test('activeHistory contains the most recent messages', async () => {
    const contextLimit = 5;
    // Threshold = 50. Need 51+ messages to trigger.
    const history = makeMessages(60);
    const callLLM = mock(async () => 'summary');
    const result = await summarizeHistory(history, contextLimit, callLLM);
    expect(result).not.toBeNull();
    expect(result!.activeHistory).toHaveLength(contextLimit);
    // The last message in activeHistory should be the last message overall
    expect(result!.activeHistory[contextLimit - 1].content).toBe('Message 60');
  });

  test('callLLM is called with summarization prompt', async () => {
    const contextLimit = 5;
    const history = makeMessages(60); // Trigger threshold > 50
    const callLLM = mock(async (msgs: AIChatMessage[]) => {
      // Verify the summarization messages structure
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe('system');
      expect(msgs[1].role).toBe('user');
      return 'summary';
    });
    await summarizeHistory(history, contextLimit, callLLM);
    expect(callLLM).toHaveBeenCalledTimes(1);
  });

  test('when callLLM throws, returns empty summary with activeHistory', async () => {
    const contextLimit = 5;
    const history = makeMessages(60);
    const callLLM = mock(async () => {
      throw new Error('LLM failure');
    });
    const result = await summarizeHistory(history, contextLimit, callLLM);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('');
    expect(result!.activeHistory).toHaveLength(contextLimit);
  });

  test('filters only user/assistant messages for summarization text', async () => {
    const contextLimit = 2; // Threshold 20
    const history: AIChatMessage[] = [];

    // Fill history to trigger threshold (need > 20 messages)
    for (let i = 0; i < 20; i++) {
        history.push({ role: 'user', content: `Filler ${i}` });
    }

    // Add specific test messages
    history.push({ role: 'system', content: 'System message' });
    history.push({ role: 'user', content: 'User msg 1' });
    history.push({ role: 'assistant', content: 'Assistant msg 1' });
    history.push({ role: 'tool', content: 'Tool result' });
    history.push({ role: 'user', content: 'User msg 2' });
    history.push({ role: 'assistant', content: 'Assistant msg 2' });

    // Total length = 20 + 6 = 26. Threshold = 20. Triggers summary.
    // contextLimit = 2. So last 2 are kept active.
    // Summarized part includes everything before last 2.

    const callLLM = mock(async (msgs: AIChatMessage[]) => {
      const userContent = msgs[1].content as string;
      // System and tool messages should not appear in the conversation text
      expect(userContent).not.toContain('System message');
      expect(userContent).not.toContain('Tool result');
      expect(userContent).toContain('User msg 1');
      expect(userContent).toContain('Assistant msg 1');
      return 'summary';
    });
    await summarizeHistory(history, contextLimit, callLLM);
    expect(callLLM).toHaveBeenCalledTimes(1);
  });
});
