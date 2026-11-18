import { describe, test, expect, mock } from 'bun:test';
import {
  extractSafeHost,
  formatToolAction,
  sanitizeInlineText,
  ToolProgressTracker,
} from '../src/agent/toolProgress';

describe('toolProgress helpers', () => {
  describe('sanitizeInlineText', () => {
    test('returns empty string for nullish values', () => {
      expect(sanitizeInlineText(null)).toBe('');
      expect(sanitizeInlineText(undefined)).toBe('');
    });

    test('collapses whitespace and strips control characters', () => {
      expect(sanitizeInlineText('hello \x00\x1F\nworld   test')).toBe('hello world test');
    });

    test('truncates strings exceeding maxLen with an ellipsis', () => {
      const longText = 'a'.repeat(80);
      const sanitized = sanitizeInlineText(longText, 20);
      expect(sanitized.length).toBe(20);
      expect(sanitized.endsWith('…')).toBe(true);
    });
  });

  describe('extractSafeHost', () => {
    test('extracts hostname and strips www', () => {
      expect(extractSafeHost('https://www.example.com/some/path?token=secret')).toBe('example.com');
      expect(extractSafeHost('http://sub.domain.org:8080/file')).toBe('sub.domain.org');
    });

    test('returns fallback for invalid URLs or empty strings', () => {
      expect(extractSafeHost('')).toBe('link');
      expect(extractSafeHost('not-a-url')).toBe('link');
      expect(extractSafeHost(null)).toBe('link');
    });
  });

  describe('formatToolAction', () => {
    test('formats web_search and web_scrape actions', () => {
      expect(formatToolAction('web_search', 'utility', { query: 'Arsenal score' })).toBe('🔍 Searching web for "Arsenal score"...');
      expect(formatToolAction('web_search', 'utility', {})).toBe('🔍 Searching web...');
      expect(formatToolAction('web_scrape', 'utility', { query: 'match report' })).toBe('📄 Reading match report...');
      expect(formatToolAction('web_scrape', 'utility', { url: 'https://www.bbc.com/sport' })).toBe('📄 Reading page from bbc.com...');
    });

    test('formats download, sticker, and media actions', () => {
      expect(formatToolAction('download_media', 'utility', { url: 'https://youtube.com/watch?v=123', format: 'mp3' })).toBe('⬇️ Downloading MP3 media from youtube.com...');
      expect(formatToolAction('sticker', 'media', {})).toBe('🎨 Creating sticker...');
      expect(formatToolAction('convert_media', 'media', { format: 'webp' })).toBe('🔄 Converting media to WEBP...');
      expect(formatToolAction('translate', 'utility', { query: 'Good morning' })).toBe('🌐 Translating "Good morning"...');
    });

    test('formats fallback actions based on category', () => {
      expect(formatToolAction('custom_cleaner', 'admin', {})).toBe('🛡️ Running custom cleaner...');
      expect(formatToolAction('custom_audio', 'media', {})).toBe('🎬 Running custom audio...');
      expect(formatToolAction('custom_cfg', 'config', {})).toBe('⚙️ Running custom cfg...');
      expect(formatToolAction('random_tool', 'misc', {})).toBe('🔧 Running random tool...');
    });
  });
});

describe('ToolProgressTracker', () => {
  test('renders steps with dynamic total and proper icons', async () => {
    const sentMessages: string[] = [];
    const editedMessages: string[] = [];
    const fakeKey = { id: 'msg-1' };

    const ctx = {
      chatId: 'test-chat',
      sendMessage: mock(async (text: string) => {
        sentMessages.push(text);
        return fakeKey;
      }),
      editMessage: mock(async (_key: unknown, text: string) => {
        editedMessages.push(text);
      }),
    };

    const tracker = new ToolProgressTracker(ctx);
    tracker.addPlannedSteps(2);

    const step1 = await tracker.startStep('🔍 Searching web for "test"...');
    expect(step1).toBe(0);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toBe('⏳ [1/2] 🔍 Searching web for "test"...');

    tracker.completeStep(step1, false);

    const step2 = await tracker.startStep('📄 Reading report...');
    expect(step2).toBe(1);
    expect(editedMessages).toHaveLength(1);
    expect(editedMessages[0]).toBe('✅ [1/2] 🔍 Searching web for "test"...\n⏳ [2/2] 📄 Reading report...');

    tracker.completeStep(step2, false);
    await tracker.flush();

    expect(editedMessages).toHaveLength(2);
    expect(editedMessages[1]).toBe('✅ [1/2] 🔍 Searching web for "test"...\n✅ [2/2] 📄 Reading report...');
  });

  test('updates icon to ❌ when a step fails', async () => {
    const editedMessages: string[] = [];
    const ctx = {
      chatId: 'test-chat',
      sendMessage: mock(async () => ({ id: 'msg-err' })),
      editMessage: mock(async (_key: unknown, text: string) => {
        editedMessages.push(text);
      }),
    };

    const tracker = new ToolProgressTracker(ctx);
    const step = await tracker.startStep('Downloading media...');
    tracker.completeStep(step, true);
    await tracker.flush();

    expect(editedMessages).toHaveLength(1);
    expect(editedMessages[0]).toBe('❌ [1/1] Downloading media...');
  });

  test('dynamically expands denominator when sequential turns add more steps', async () => {
    const sentMessages: string[] = [];
    const editedMessages: string[] = [];

    const ctx = {
      chatId: 'test-chat',
      sendMessage: mock(async (text: string) => {
        sentMessages.push(text);
        return 'key-turn';
      }),
      editMessage: mock(async (_key: unknown, text: string) => {
        editedMessages.push(text);
      }),
    };

    const tracker = new ToolProgressTracker(ctx);

    // Turn 1: 1 planned step
    tracker.addPlannedSteps(1);
    const step1 = await tracker.startStep('Step 1');
    expect(sentMessages[0]).toBe('⏳ [1/1] Step 1');
    tracker.completeStep(step1, false);
    await tracker.flush();
    expect(editedMessages[0]).toBe('✅ [1/1] Step 1');

    // Turn 2: LLM decided it needs 1 more step
    tracker.addPlannedSteps(1);
    const step2 = await tracker.startStep('Step 2');
    expect(editedMessages[1]).toBe('✅ [1/2] Step 1\n⏳ [2/2] Step 2');
    tracker.completeStep(step2, false);
    await tracker.flush();
    expect(editedMessages[2]).toBe('✅ [1/2] Step 1\n✅ [2/2] Step 2');
  });

  test('does not adopt a message key once it has been disabled', async () => {
    // A tracker whose send failed can no longer edit anything. Reporting a
    // successful adoption made the caller skip the finalising edit, leaving the
    // streamed bubble frozen on its cursor.
    const ctx = {
      chatId: 'test-chat',
      sendMessage: mock(async () => { throw new Error('send failed'); }),
      editMessage: mock(async () => {}),
    };
    const tracker = new ToolProgressTracker(ctx);
    await tracker.startStep('Step');
    expect(tracker.adoptMessageKey({ id: 'streamed' })).toBe(false);
  });

  test('degrades gracefully when provider throws during editMessage', async () => {
    let warningLogged = false;
    const ctx = {
      chatId: 'test-chat',
      sendMessage: mock(async () => 'key'),
      editMessage: mock(async () => {
        throw new Error('Telegram edit rate limit');
      }),
    };

    const tracker = new ToolProgressTracker(ctx, () => {
      warningLogged = true;
    });

    const step1 = await tracker.startStep('Step 1');
    tracker.completeStep(step1, false);

    // Flushing should encounter the error, log warning, and disable future edits without throwing
    await expect(tracker.flush()).resolves.toBeUndefined();
    expect(warningLogged).toBe(true);

    // Subsequent actions should be no-ops and not throw
    await expect(tracker.startStep('Step 2')).resolves.toBe(1);
  });
});

describe('ToolProgressTracker render bound', () => {
  /**
   * `editMessage` grows a message by re-editing its head and posting the
   * remainder as *new* messages, so an unbounded step list re-posted its tail on
   * every sync — the same duplication the assistant preview avoids.
   */
  test('bounds the rendered status instead of growing without limit', async () => {
    const sent: string[] = [];
    const ctx = {
      chatId: 'test-chat',
      sendMessage: mock(async (text: string) => {
        sent.push(text);
        return { id: 'msg-long' };
      }),
      editMessage: mock(async () => undefined),
    };

    const tracker = new ToolProgressTracker(ctx);
    for (let i = 0; i < 60; i++) {
      await tracker.startStep(`step ${i} ${'x'.repeat(40)}`);
    }

    const rendered = tracker.render();
    expect(rendered.length).toBeLessThanOrEqual(1_803);
    expect(rendered).toContain('more steps');
    expect(sent[0]!.length).toBeLessThanOrEqual(1_803);
    // The footer must report the lines actually hidden, not `total - 1`.
    const dropped = Number(rendered.match(/\(\+(\d+) more steps?\)/)?.[1]);
    const shownLines = rendered.split('\n').length - 1;
    expect(shownLines + dropped).toBe(60);
    // The old formula always reported `total - 1` (59); the real remainder is
    // much smaller because the cap keeps dozens of lines.
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThan(59);
  });
});
