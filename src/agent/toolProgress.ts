import type { MessageContext } from '../core/MessageContext';

export type ToolStepState = 'running' | 'completed' | 'failed';

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

export function formatToolAction(
  toolName: string,
  category: string,
  args: Record<string, unknown> = {},
): string {
  switch (toolName) {
    case 'web_search': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q ? `🔍 Searching web for "${sanitizeInlineText(q, 60)}"...` : '🔍 Searching web...';
    }
    case 'web_scrape': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      const u = typeof args.url === 'string' ? args.url.trim() : '';
      if (q) return `📄 Reading ${sanitizeInlineText(q, 60)}...`;
      if (u) return `📄 Reading page from ${extractSafeHost(u)}...`;
      return '📄 Reading webpage...';
    }
    case 'find_tools': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q ? `🔎 Finding tools for "${sanitizeInlineText(q, 50)}"...` : '🔎 Finding tools...';
    }
    case 'game_search': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q ? `🎮 Searching games for "${sanitizeInlineText(q, 60)}"...` : '🎮 Searching games...';
    }
    case 'software_search': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q ? `💻 Searching software for "${sanitizeInlineText(q, 60)}"...` : '💻 Searching software...';
    }
    case 'download': {
      const fmt = typeof args.format === 'string' && args.format.trim()
        ? `${sanitizeInlineText(args.format, 10).toUpperCase()} `
        : '';
      const host = extractSafeHost(args.url);
      return `⬇️ Downloading ${fmt}media from ${host}...`;
    }
    case 'make_sticker':
      return '🎨 Creating sticker...';
    case 'media_convert': {
      const fmt = typeof args.format === 'string' && args.format.trim()
        ? ` to ${sanitizeInlineText(args.format, 10).toUpperCase()}`
        : '';
      return `🔄 Converting media${fmt}...`;
    }
    case 'translate': {
      const lang = typeof args.target_language === 'string' && args.target_language.trim()
        ? ` to ${sanitizeInlineText(args.target_language, 30)}`
        : '';
      return `🌐 Translating${lang}...`;
    }
    case 'speak':
      return '🔊 Generating voice note...';
    case 'transcribe_audio':
      return '🎙️ Transcribing audio...';
    case 'pdf': {
      const action = typeof args.action === 'string' && args.action.trim()
        ? sanitizeInlineText(args.action.replace(/_/g, ' '), 30)
        : 'document';
      return `📑 Processing PDF (${action})...`;
    }
    case 'media_search': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q ? `🎬 Searching media for "${sanitizeInlineText(q, 60)}"...` : '🎬 Searching media...';
    }
    case 'media_request':
      return '📥 Processing media request...';
    case 'media_library': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q ? `📚 Searching library for "${sanitizeInlineText(q, 60)}"...` : '📚 Checking media library...';
    }
    case 'reminder': {
      const action = typeof args.action === 'string' && args.action.trim()
        ? sanitizeInlineText(args.action, 20)
        : 'update';
      return `⏰ Managing reminders (${action})...`;
    }
    case 'memory': {
      const action = typeof args.action === 'string' && args.action.trim()
        ? sanitizeInlineText(args.action, 20)
        : 'lookup';
      return `🧠 Accessing memory (${action})...`;
    }
    case 'knowledge': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      return q ? `📖 Searching room knowledge for "${sanitizeInlineText(q, 50)}"...` : '📖 Managing room knowledge...';
    }
    default: {
      let emoji = '🔧';
      if (category === 'media') emoji = '🎬';
      else if (category === 'admin' || category === 'moderation' || category === 'owner') emoji = '🛡️';
      else if (category === 'system' || category === 'config') emoji = '⚙️';
      return `${emoji} Running ${toolName.replace(/_/g, ' ')}...`;
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

  adoptMessageKey(key: unknown): void {
    if (key !== null && key !== undefined && this.statusMessageKey === null) {
      this.statusMessageKey = key;
    }
  }

  addPlannedSteps(count: number): void {
    if (count > 0) {
      this.plannedTotal += count;
    }
  }

  render(): string {
    const total = Math.max(this.steps.length, this.plannedTotal);
    return this.steps
      .map((step, i) => {
        const icon = step.state === 'running' ? '⏳' : step.state === 'completed' ? '✅' : '❌';
        return `${icon} [${i + 1}/${total}] ${step.description}`;
      })
      .join('\n');
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
