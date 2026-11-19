import type { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';

export type ToolStepState = 'running' | 'completed' | 'failed';

/** Longest rendered progress message; see {@link ToolProgressTracker.render}. */
const MAX_PROGRESS_CHARS = 1_800;

export interface ToolProgressStep {
  description: string;
  state: ToolStepState;
}

export function sanitizeInlineText(value: unknown, maxLen = 60): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  const text = Array.from(raw, character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 1))}…`;
}

export function extractSafeHost(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return 'link';
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.replace(/^www\./i, '');
    return host || 'link';
  } catch {
    return 'link';
  }
}

/**
 * Human-readable progress line for a running tool.
 *
 * `lang` is the room language; it is optional so callers that render progress
 * outside a chat context (tests, logs) still get the English wording.
 */
export function formatToolAction(
  toolName: string,
  category: string,
  args: Record<string, unknown> = {},
  lang?: string,
): string {
  switch (toolName) {
    case 'web_search': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q
        ? t(lang, 'progress.web_search_query', { query: sanitizeInlineText(q, 60) })
        : t(lang, 'progress.web_search');
    }
    case 'web_scrape': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      const u = typeof args.url === 'string' ? args.url.trim() : '';
      if (q) return t(lang, 'progress.web_scrape_query', { query: sanitizeInlineText(q, 60) });
      if (u) return t(lang, 'progress.web_scrape_page', { host: extractSafeHost(u) });
      return t(lang, 'progress.web_scrape');
    }
    case 'find_tools': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q
        ? t(lang, 'progress.find_tools_query', { query: sanitizeInlineText(q, 50) })
        : t(lang, 'progress.find_tools');
    }
    case 'game_search': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q
        ? t(lang, 'progress.game_search_query', { query: sanitizeInlineText(q, 60) })
        : t(lang, 'progress.game_search');
    }
    case 'software_search': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q
        ? t(lang, 'progress.software_search_query', { query: sanitizeInlineText(q, 60) })
        : t(lang, 'progress.software_search');
    }
    case 'download_media': {
      const host = extractSafeHost(args.url);
      const hasFormat = typeof args.format === 'string' && args.format.trim();
      return hasFormat
        ? t(lang, 'progress.download_format', { format: sanitizeInlineText(args.format, 10).toUpperCase(), host })
        : t(lang, 'progress.download', { host });
    }
    case 'sticker':
      return t(lang, 'progress.sticker');
    case 'convert_media': {
      const hasFormat = typeof args.format === 'string' && args.format.trim();
      return hasFormat
        ? t(lang, 'progress.convert_media_format', { format: sanitizeInlineText(args.format, 10).toUpperCase() })
        : t(lang, 'progress.convert_media');
    }
    case 'translate': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q
        ? t(lang, 'progress.translate_query', { query: sanitizeInlineText(q, 40) })
        : t(lang, 'progress.translate');
    }
    case 'speak':
      return t(lang, 'progress.speak');
    case 'transcribe_audio':
      return t(lang, 'progress.transcribe');
    case 'pdf_tool': {
      const action = typeof args.action === 'string' && args.action.trim()
        ? sanitizeInlineText(args.action.replace(/_/g, ' '), 30)
        : 'document';
      return t(lang, 'progress.pdf', { action });
    }
    case 'media_search': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q
        ? t(lang, 'progress.media_search_query', { query: sanitizeInlineText(q, 60) })
        : t(lang, 'progress.media_search');
    }
    case 'media_request':
      return t(lang, 'progress.media_request');
    case 'media_library': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q
        ? t(lang, 'progress.media_library_query', { query: sanitizeInlineText(q, 60) })
        : t(lang, 'progress.media_library');
    }
    case 'reminder': {
      const action = typeof args.action === 'string' && args.action.trim()
        ? sanitizeInlineText(args.action, 20)
        : 'update';
      return t(lang, 'progress.reminder', { action });
    }
    case 'memory': {
      const action = typeof args.action === 'string' && args.action.trim()
        ? sanitizeInlineText(args.action, 20)
        : 'lookup';
      return t(lang, 'progress.memory', { action });
    }
    case 'knowledge': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q
        ? t(lang, 'progress.knowledge_query', { query: sanitizeInlineText(q, 50) })
        : t(lang, 'progress.knowledge');
    }
    default: {
      let emoji = '🔧';
      if (category === 'media') emoji = '🎬';
      else if (category === 'admin' || category === 'moderation' || category === 'owner') emoji = '🛡️';
      else if (category === 'system' || category === 'config') emoji = '⚙️';
      return t(lang, 'progress.running', { emoji, tool: toolName.replace(/_/g, ' ') });
    }
  }
}

export class ToolProgressTracker {
  private readonly steps: ToolProgressStep[] = [];
  private plannedTotal = 0;
  private statusMessageKey: unknown = null;
  private disabled = false;

  constructor(
    private readonly ctx: Pick<MessageContext, 'sendMessage' | 'editMessage' | 'signal' | 'chatId'>,
    private readonly logWarn?: (err: unknown, phase: string) => void,
  ) {}

  private isSupported(): boolean {
    return (
      !this.disabled &&
      typeof this.ctx.sendMessage === 'function' &&
      typeof this.ctx.editMessage === 'function'
    );
  }

  /**
   * Take ownership of a message key so tool-progress updates can edit that
   * message.
   *
   * Returns `true` when the tracker owns the message afterwards. Only the first
   * key is ever adopted, so a later streamed bubble is not owned and must be
   * finalised by its sender.
   */
  adoptMessageKey(key: unknown): boolean {
    // A disabled tracker cannot edit the message it would adopt, so claiming it
    // meant the caller (which skips the finalising edit when adoption succeeds)
    // left the bubble frozen on its streaming cursor forever.
    if (this.disabled) return false;
    if (key === null || key === undefined || this.statusMessageKey !== null) return false;
    this.statusMessageKey = key;
    return true;
  }

  addPlannedSteps(count: number): void {
    if (count > 0) {
      this.plannedTotal += count;
    }
  }

  render(): string {
    const total = Math.max(this.steps.length, this.plannedTotal);
    const lines = this.steps.map((step, i) => {
      const icon = step.state === 'running' ? '⏳' : step.state === 'completed' ? '✅' : '❌';
      return `${icon} [${i + 1}/${total}] ${step.description}`;
    });
    // Bound the rendered status: `editMessage` grows a message by editing its head
    // and posting the remainder as *new* messages, so an unbounded step list
    // re-posted its tail on every sync — the same duplication the assistant
    // preview avoids. The cap matches Discord's smallest platform limit.
    const text = lines.join('\n');
    if (text.length <= MAX_PROGRESS_CHARS) return text;
    let end = MAX_PROGRESS_CHARS - 20;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    const kept = text.slice(0, end);
    // Count the lines actually hidden. The previous `lines.length - 1` assumed
    // the cap keeps exactly one line, so "(+N more steps)" overstated the
    // remainder for every ordinary multi-line status.
    const shownLines = kept.split('\n').length;
    const dropped = lines.length - shownLines;
    const footer = dropped > 0 ? `\n(+${dropped} more step${dropped === 1 ? '' : 's'})` : '';
    return `${kept}…${footer}`;
  }

  async startStep(description: string): Promise<number> {
    this.steps.push({ description, state: 'running' });
    if (this.steps.length > this.plannedTotal) {
      this.plannedTotal = this.steps.length;
    }
    await this.syncMessage('start');
    return this.steps.length - 1;
  }

  completeStep(index: number, failed: boolean): void {
    if (index >= 0 && index < this.steps.length) {
      this.steps[index]!.state = failed ? 'failed' : 'completed';
    }
  }

  async flush(): Promise<void> {
    if (this.steps.length > 0) {
      await this.syncMessage('flush');
    }
  }

  private async syncMessage(phase: string): Promise<void> {
    if (!this.isSupported() || this.steps.length === 0) return;
    const text = this.render();
    try {
      if (this.statusMessageKey === null) {
        this.statusMessageKey = await this.ctx.sendMessage!(
          text,
          this.ctx.signal ? { signal: this.ctx.signal } : undefined,
        );
      } else {
        await this.ctx.editMessage!(this.statusMessageKey, text);
      }
    } catch (err: unknown) {
      this.logWarn?.(err, phase);
      this.disabled = true;
    }
  }
}
